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
 * Two functions are exceptions, both because neither can widen access.
 * `clearFailures` failing leaves a scope MORE restricted, never less.
 * `getScopeLockState` reads lock state for operator surfaces to DISPLAY and
 * gates nothing — see its own docblock.
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
  /**
   * Current value of a counter key, or 0 when it is absent/expired. THROWS on
   * a store error; the one read-only caller (`getScopeLockState`) decides what
   * to do with that, since it drives a display rather than a credential gate.
   */
  count(key: string): Promise<number>;
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
  async count(key: string): Promise<number> {
    const raw = await this.r.get(key);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  async clear(keys: string[]): Promise<void> {
    try {
      await this.r.del(...keys);
    } catch (err) {
      // Deliberately swallowed: see the fail-closed note on this module. A
      // stale counter can only over-restrict, and the TTL removes it anyway.
      noteStoreFailure('clear', err, 'a counter or lock will linger until its TTL');
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

function noteStoreFailure(
  op: string,
  err: unknown,
  // The consequence is passed in rather than assumed: most operations here fail
  // closed, but `clear`/`clearFailures` and the display-only `getScopeLockState`
  // fail open, and a log line that told an operator "auth is refusing attempts"
  // while auth was in fact serving would send them looking in the wrong place.
  consequence = 'auth is refusing attempts until it recovers',
): void {
  const now = Date.now();
  const previous = lastLoggedAt.get(op) ?? 0;
  if (now - previous < STORE_FAILURE_LOG_INTERVAL_MS) return;
  lastLoggedAt.set(op, now);
  // console rather than the Fastify logger: this module has no request context,
  // and the message must not carry the connection string from the raw error.
  console.error(
    `[brute-force] store operation "${op}" failed; ${consequence}`,
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
  async count(key: string): Promise<number> {
    const e = this.m.get(key);
    if (!e || e.expiresAt <= Date.now()) return 0;
    return e.value;
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
 * Scope prefix for end-user password sign-in lockouts.
 *
 * Kept here so the super-admin dashboard can ENUMERATE active end-user locks —
 * the individual `bf:lock:*` TTL keys aren't otherwise discoverable, which is
 * why the old `EndUser.lockedUntil` KPI silently read zero after lockout moved
 * to Redis.
 */
export const EU_LOGIN_LOCK_SCOPE_PREFIX = 'eu:login:';

/**
 * THE scope for an end-user's password sign-in lockout.
 *
 * This used to be a private `loginLockScope()` in auth.service.ts, duplicated
 * as a prefix constant here. Every reader of a lock has to derive the key
 * byte-for-byte the way the writer did or the lookup silently answers "not
 * locked" — the exact failure mode that made the operator panel report the
 * opposite of the truth. One exported builder, one lowercasing rule, so a
 * divergence is impossible rather than merely documented.
 *
 * The email is lowercased because sign-in looks the row up
 * case-insensitively; scoping on the raw input would give an attacker a fresh
 * counter per capitalisation of the same address.
 */
export function euLoginLockScope(applicationId: string, email: string): string {
  return `${EU_LOGIN_LOCK_SCOPE_PREFIX}${applicationId}:${email.toLowerCase()}`;
}

/** Live lockout state of one scope, for read-only operator surfaces. */
export interface ScopeLockState {
  /** Remaining lock duration in seconds. `null` when the scope is NOT locked. */
  lockedForSec: number | null;
  /**
   * Failures recorded in the current window.
   *
   * `registerFailure` deletes this counter at the instant it sets the lock, so
   * a locked scope reads 0 here. `lockedForSec` is the lockout signal; this is
   * only the "how close is this account to locking" number.
   */
  failuresInWindow: number;
}

/**
 * Read one scope's lockout state. `null` means "could not tell".
 *
 * The companion to `scanActiveLoginLocks` (which enumerates) and
 * `assertNotLocked` (which enforces): this answers "is THIS scope locked, and
 * for how long" without throwing a 429 at the caller, for operator surfaces
 * that display lock state rather than gate on it.
 *
 * **Fail-OPEN, deliberately, and the only read in this module that is.** The
 * fail-closed rule at the top of the file protects the credential path: a lock
 * we cannot read must never be treated as absent *when deciding whether to let
 * someone in*. This function decides nothing — it renders a badge in the
 * operator panel. Propagating the error would 503 an entire end-user detail
 * page because Redis blipped, and it cannot open a hole: `assertNotLocked`
 * still refuses every sign-in attempt during the same outage, so the account
 * this returns `null` for is in practice *more* locked, not less. Callers must
 * still distinguish `null` from "not locked" rather than flattening it.
 */
export async function getScopeLockState(scope: string): Promise<ScopeLockState | null> {
  const { fail, lock } = keysFor(scope);
  try {
    const s = store();
    const [ttl, failures] = await Promise.all([s.lockTtl(lock), s.count(fail)]);
    return { lockedForSec: ttl > 0 ? ttl : null, failuresInWindow: failures };
  } catch (err) {
    noteStoreFailure(
      'getScopeLockState',
      err,
      'operator surfaces cannot show lock state (sign-in itself still fails closed)',
    );
    return null;
  }
}

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

/** What `registerFailure` counted, so the caller can write an audit trail. */
export interface RegisteredFailure {
  /** Failures inside the current window, including this one. */
  failures: number;
  /** True on the attempt that TRIPPED the lock — once per lockout, not per attempt. */
  locked: boolean;
  /** Seconds the scope is locked for, when `locked`. */
  lockedForSec: number;
}

/**
 * Record a failed attempt against `scope`; lock it once the threshold is hit.
 *
 * Fails closed for the same reason as `assertNotLocked`: an attempt we could not
 * count is an attempt that does not count towards the threshold, which is the
 * whole exploit. The caller has already rejected the credential by this point,
 * so the 503 replaces a 401 — deliberately, because it also stops the endpoint
 * being a free oracle while the counter is broken.
 *
 * Returns what it counted. The counter itself is in Redis with a TTL and is
 * cleared on the successful sign-in, so it answers "is this account locked
 * right now" and nothing else — an operator asking "why couldn't this user sign
 * in yesterday" needs a durable row, and only the caller knows which
 * end-user and Application to attribute it to.
 */
export async function registerFailure(
  scope: string,
  policy: BruteForcePolicy,
): Promise<RegisteredFailure> {
  const { fail, lock } = keysFor(scope);
  try {
    const count = await store().incrWithTtl(fail, policy.windowSec);
    if (count >= policy.threshold) {
      await store().setLock(lock, policy.lockSec);
      await store().clear([fail]);
      return { failures: count, locked: true, lockedForSec: policy.lockSec };
    }
    return { failures: count, locked: false, lockedForSec: 0 };
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
    noteStoreFailure('clearFailures', err, 'a counter or lock will linger until its TTL');
  }
}

/**
 * Drop the in-memory counter store.
 *
 * Test-only, and the one that actually mattered. Under `NODE_ENV=test`
 * `getRedis()` returns null, so every counter and lock lives in the
 * module-level `MemoryStore` above and nothing cleared it between tests. Keys
 * are `bf:lock:<scope>:<appId>:<email>`, which outlives the TRUNCATE that
 * removed the end-user they refer to — so a lockout tripped by one test was
 * still counting when a later one created a fresh end-user with a recycled
 * address and could not sign in.
 *
 * test/setup.ts believed it was clearing this via Redis. It was not: its
 * `clearRedisTestState` called `getRedis()`, got null, and returned
 * immediately on all 950 invocations — deleting zero keys, for a store that
 * was never Redis in the first place.
 */
export function __resetForTests(): void {
  memory = null;
}
