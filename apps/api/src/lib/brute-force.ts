/**
 * Brute-force protection — distributed, Redis-backed attempt counters.
 *
 * Replaces the per-attempt DB writes that account-lockout + MFA-throttle used
 * to do (a write on every failed login does not scale under credential
 * stuffing, and contends on hot rows). Counters live in Redis as `INCR` keys
 * with a TTL (a fixed-window limiter); once a scope crosses its threshold a
 * short-lived lock key is set. Shared across replicas via the one Redis client.
 *
 * **Fail-CLOSED.** This used to swallow every Redis error and return "0 / not
 * locked", which meant an outage did two things: failed sign-ins stopped being
 * counted (unlimited password guessing) and, worse, an account that was ALREADY
 * locked read as unlocked, so an attacker who had tripped a lockout was let
 * straight back in. Protection was silently off exactly when it mattered.
 *
 * Now a store error propagates and the caller answers 503
 * `DEPENDENCY_UNAVAILABLE`, so authentication is briefly unavailable instead of
 * unprotected. That is the deliberate trade: fail-open on a credential control
 * is worse than reduced availability. Non-auth routes keep serving (the generic
 * capacity limiter still fails open, since it protects throughput rather than
 * credentials), so a Redis outage degrades the product rather than taking it
 * down.
 *
 * The one exception is `clearFailures`. Failing to clear a counter leaves a
 * scope MORE restricted, never less, so an error there is safe to swallow.
 *
 * In tests (no Redis) an in-memory store backs the same logic so the regression
 * tests are deterministic without an external dependency.
 */

import type { Redis } from 'ioredis';
import { getRedis } from './redis.js';
import { dependencyUnavailablePayload, RekeyError } from './error.js';

export interface BruteForcePolicy {
  /** Failures within the window before the scope locks. */
  threshold: number;
  /** Rolling window the failures are counted over, seconds. */
  windowSec: number;
  /** How long the lock lasts once tripped, seconds. */
  lockSec: number;
}

// Password sign-in: 10 failures / 15 min → 15-min lock (matches the prior policy).
export const LOGIN_POLICY: BruteForcePolicy = { threshold: 10, windowSec: 15 * 60, lockSec: 15 * 60 };
// MFA verify: tighter (6-digit codes) — 5 failures / 15 min → 15-min lock.
export const MFA_POLICY: BruteForcePolicy = { threshold: 5, windowSec: 15 * 60, lockSec: 15 * 60 };

interface CounterStore {
  /**
   * INCR the key, setting the TTL on first hit. Returns the new count.
   * THROWS on a store error — a swallowed error here reads as "no failures yet".
   */
  incrWithTtl(key: string, ttlSec: number): Promise<number>;
  /** THROWS on a store error — a swallowed error here silently skips the lock. */
  setLock(key: string, ttlSec: number): Promise<void>;
  /**
   * Remaining lock TTL in seconds, or 0 if not locked.
   * THROWS on a store error — a swallowed error here reads as "not locked",
   * which released every already-locked account during an outage.
   */
  lockTtl(key: string): Promise<number>;
  /** Best-effort. Failing to clear leaves a scope more restricted, not less. */
  clear(keys: string[]): Promise<void>;
}

class RedisStore implements CounterStore {
  constructor(private readonly r: Redis) {}
  async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    const n = await this.r.incr(key);
    // A failed EXPIRE would leave the counter without a TTL, i.e. permanently
    // accumulating. Let it throw: the caller refuses the attempt, and the next
    // successful attempt re-runs this path.
    if (n === 1) await this.r.expire(key, ttlSec);
    return n;
  }
  async setLock(key: string, ttlSec: number): Promise<void> {
    await this.r.set(key, '1', 'EX', ttlSec);
  }
  async lockTtl(key: string): Promise<number> {
    const t = await this.r.ttl(key);
    return t > 0 ? t : 0;
  }
  async clear(keys: string[]): Promise<void> {
    try {
      await this.r.del(...keys);
    } catch (err) {
      // Deliberately swallowed: see the fail-closed note on this module. A
      // stale counter can only over-restrict, and the TTL removes it anyway.
      noteStoreFailure('clear', err);
    }
  }
}

/**
 * Log a store failure, throttled.
 *
 * An outage means every auth attempt hits this, so an unthrottled log (or a
 * security-event row per request) would bury the signal it is meant to raise.
 * One line per operation per minute is enough to tell an operator which
 * subsystem broke and when it started.
 */
const lastLoggedAt = new Map<string, number>();
const STORE_FAILURE_LOG_INTERVAL_MS = 60_000;

function noteStoreFailure(op: string, err: unknown): void {
  const now = Date.now();
  const previous = lastLoggedAt.get(op) ?? 0;
  if (now - previous < STORE_FAILURE_LOG_INTERVAL_MS) return;
  lastLoggedAt.set(op, now);
  // console rather than the Fastify logger: this module has no request context,
  // and the message must not carry the connection string from the raw error.
  console.error(
    `[brute-force] store operation "${op}" failed; auth is refusing attempts until it recovers`,
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * Turn a store error into the 503 the caller should answer with.
 *
 * Rethrows a RekeyError untouched so a genuine 429 lockout (thrown by
 * `assertNotLocked` itself) is not relabelled as an outage.
 */
function asDependencyFailure(op: string, err: unknown): never {
  if (err instanceof RekeyError) throw err;
  noteStoreFailure(op, err);
  throw new RekeyError(dependencyUnavailablePayload('redis'));
}

/** Process-local fallback used only in tests (no Redis). */
class MemoryStore implements CounterStore {
  private readonly m = new Map<string, { value: number; expiresAt: number }>();
  async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    const now = Date.now();
    const e = this.m.get(key);
    if (!e || e.expiresAt <= now) {
      this.m.set(key, { value: 1, expiresAt: now + ttlSec * 1000 });
      return 1;
    }
    e.value += 1;
    return e.value;
  }
  async setLock(key: string, ttlSec: number): Promise<void> {
    this.m.set(key, { value: 1, expiresAt: Date.now() + ttlSec * 1000 });
  }
  async lockTtl(key: string): Promise<number> {
    const e = this.m.get(key);
    const now = Date.now();
    if (!e || e.expiresAt <= now) return 0;
    return Math.ceil((e.expiresAt - now) / 1000);
  }
  async clear(keys: string[]): Promise<void> {
    for (const k of keys) this.m.delete(k);
  }
}

let memory: MemoryStore | null = null;
function store(): CounterStore {
  const r = getRedis();
  if (r) return new RedisStore(r);
  // No client. Outside tests this is not a mode to support: the counters would
  // be per-process, so N replicas would grant N times the attempts and a
  // restart would clear every lock. Production already refuses to boot without
  // REDIS_URL, so reaching here in production is a bug — say so rather than
  // quietly running unprotected.
  if (process.env.NODE_ENV === 'production') {
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
  if (!memory) memory = new MemoryStore();
  return memory;
}

const LOCK_KEY_PREFIX = 'bf:lock:';

function keysFor(scope: string): { fail: string; lock: string } {
  return { fail: `bf:fail:${scope}`, lock: `${LOCK_KEY_PREFIX}${scope}` };
}

/**
 * Scope prefix for end-user password sign-in lockouts. MUST mirror the scope
 * built by `loginLockScope()` in modules/auth/auth.service.ts, which is
 * `eu:login:${applicationId}:${email}`. Kept here so the super-admin dashboard
 * can ENUMERATE active end-user locks — the individual `bf:lock:*` TTL keys
 * aren't otherwise discoverable, which is why the old `EndUser.lockedUntil`
 * KPI silently read zero after lockout moved to Redis. If the auth-service
 * scope format changes, change this too.
 */
export const EU_LOGIN_LOCK_SCOPE_PREFIX = 'eu:login:';

export interface ActiveLoginLock {
  applicationId: string;
  email: string;
  /** Remaining lock duration, seconds (from the key's TTL). */
  ttlSec: number;
}

/**
 * Enumerate the end-user password-login scopes currently locked. Backed by a
 * Redis `SCAN` over `bf:lock:eu:login:*`; the lock key itself carries the
 * (applicationId, email) pair, so locked accounts are recoverable without a
 * dedicated DB column. Fail-open: returns `{ total: 0, locks: [] }` whenever
 * Redis is unavailable (incl. NODE_ENV=test, where there is no client).
 *
 * `total` is the full count of matching keys; `limit` only bounds how many
 * keys we resolve TTLs for (pass 0 when you just need the count, e.g. the
 * overview KPI).
 */
export async function scanActiveLoginLocks(
  limit: number,
): Promise<{ total: number; locks: ActiveLoginLock[] }> {
  const r = getRedis();
  if (!r) return { total: 0, locks: [] };
  const pattern = `${LOCK_KEY_PREFIX}${EU_LOGIN_LOCK_SCOPE_PREFIX}*`;
  const keys: string[] = [];
  try {
    let cursor = '0';
    do {
      const [next, batch] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
      // Safety bound — a pathological keyspace shouldn't pin the event loop.
      if (keys.length >= 10_000) break;
    } while (cursor !== '0');
  } catch {
    return { total: 0, locks: [] }; // fail-open
  }
  const total = keys.length;
  const slice = limit > 0 ? keys.slice(0, limit) : [];
  const resolved = await Promise.all(
    slice.map(async (key): Promise<ActiveLoginLock | null> => {
      // key === `bf:lock:eu:login:${applicationId}:${email}`. applicationId is
      // a cuid (no ':'), so split the first ':' after the scope prefix.
      const rest = key.slice(LOCK_KEY_PREFIX.length + EU_LOGIN_LOCK_SCOPE_PREFIX.length);
      const sep = rest.indexOf(':');
      if (sep === -1) return null;
      const applicationId = rest.slice(0, sep);
      const email = rest.slice(sep + 1);
      let ttlSec = 0;
      try {
        const t = await r.ttl(key);
        ttlSec = t > 0 ? t : 0;
      } catch {
        ttlSec = 0;
      }
      return { applicationId, email, ttlSec };
    }),
  );
  return { total, locks: resolved.filter((l): l is ActiveLoginLock => l !== null) };
}

/**
 * Throw 429 if `scope` is currently locked. Call BEFORE verifying the
 * credential so a locked scope never runs the (expensive / leakable) check.
 */
export async function assertNotLocked(
  scope: string,
  code = 'TOO_MANY_FAILED_ATTEMPTS',
): Promise<void> {
  // Fail closed: if the lock state cannot be read we must not proceed as though
  // the scope were unlocked. This runs before the credential check, so an
  // outage refuses the attempt rather than allowing an unbounded number of them.
  let ttl: number;
  try {
    ttl = await store().lockTtl(keysFor(scope).lock);
  } catch (err) {
    asDependencyFailure('lockTtl', err);
  }
  if (ttl > 0) {
    throw new RekeyError({
      statusCode: 429,
      code,
      message: `Too many attempts. Try again in ${ttl}s.`,
      fix: 'Wait for the lockout window to expire, then retry.',
      retryAfterSeconds: ttl,
    });
  }
}

/**
 * Record a failed attempt against `scope`; lock it once the threshold is hit.
 *
 * Fails closed for the same reason as `assertNotLocked`: an attempt we could not
 * count is an attempt that does not count towards the threshold, which is the
 * whole exploit. The caller has already rejected the credential by this point,
 * so the 503 replaces a 401 — deliberately, because it also stops the endpoint
 * being a free oracle while the counter is broken.
 */
export async function registerFailure(scope: string, policy: BruteForcePolicy): Promise<void> {
  const { fail, lock } = keysFor(scope);
  try {
    const count = await store().incrWithTtl(fail, policy.windowSec);
    if (count >= policy.threshold) {
      await store().setLock(lock, policy.lockSec);
      await store().clear([fail]);
    }
  } catch (err) {
    asDependencyFailure('incrWithTtl', err);
  }
}

/**
 * Clear the failure counter + any lock on success.
 *
 * Best-effort on purpose. A failure here leaves a counter or lock in place,
 * which can only be more restrictive than intended and expires on its own TTL.
 * Refusing a sign-in whose credentials were correct would trade a real outage
 * for no security gain, so this is the one path that stays fail-open.
 */
export async function clearFailures(scope: string): Promise<void> {
  const { fail, lock } = keysFor(scope);
  try {
    await store().clear([fail, lock]);
  } catch (err) {
    noteStoreFailure('clearFailures', err);
  }
}
