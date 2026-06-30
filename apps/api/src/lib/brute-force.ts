/**
 * Brute-force protection — distributed, Redis-backed attempt counters.
 *
 * Replaces the per-attempt DB writes that account-lockout + MFA-throttle used
 * to do (a write on every failed login does not scale under credential
 * stuffing, and contends on hot rows). Counters live in Redis as `INCR` keys
 * with a TTL (a fixed-window limiter); once a scope crosses its threshold a
 * short-lived lock key is set. Shared across replicas via the one Redis client.
 *
 * **Fail-open.** Every Redis op is wrapped so an error/outage yields "0 / not
 * locked" — protection silently degrades to off rather than blocking auth. In
 * tests (no Redis) an in-memory store backs the same logic so the regression
 * tests are deterministic without an external dependency.
 */

import type { Redis } from 'ioredis';
import { getRedis } from './redis.js';
import { RelipayError } from './error.js';

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
  /** INCR the key, setting the TTL on first hit. Returns the new count (0 on error). */
  incrWithTtl(key: string, ttlSec: number): Promise<number>;
  setLock(key: string, ttlSec: number): Promise<void>;
  /** Remaining lock TTL in seconds, or 0 if not locked. */
  lockTtl(key: string): Promise<number>;
  clear(keys: string[]): Promise<void>;
}

class RedisStore implements CounterStore {
  constructor(private readonly r: Redis) {}
  async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    try {
      const n = await this.r.incr(key);
      if (n === 1) await this.r.expire(key, ttlSec);
      return n;
    } catch {
      return 0; // fail-open: 0 never trips the threshold
    }
  }
  async setLock(key: string, ttlSec: number): Promise<void> {
    try {
      await this.r.set(key, '1', 'EX', ttlSec);
    } catch {
      /* fail-open */
    }
  }
  async lockTtl(key: string): Promise<number> {
    try {
      const t = await this.r.ttl(key);
      return t > 0 ? t : 0;
    } catch {
      return 0; // fail-open: treat as not locked
    }
  }
  async clear(keys: string[]): Promise<void> {
    try {
      await this.r.del(...keys);
    } catch {
      /* fail-open */
    }
  }
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
  const ttl = await store().lockTtl(keysFor(scope).lock);
  if (ttl > 0) {
    throw new RelipayError({
      statusCode: 429,
      code,
      message: `Too many attempts. Try again in ${ttl}s.`,
      fix: 'Wait for the lockout window to expire, then retry.',
      retryAfterSeconds: ttl,
    });
  }
}

/** Record a failed attempt against `scope`; lock it once the threshold is hit. */
export async function registerFailure(scope: string, policy: BruteForcePolicy): Promise<void> {
  const { fail, lock } = keysFor(scope);
  const count = await store().incrWithTtl(fail, policy.windowSec);
  if (count >= policy.threshold) {
    await store().setLock(lock, policy.lockSec);
    await store().clear([fail]);
  }
}

/** Clear the failure counter + any lock on success. */
export async function clearFailures(scope: string): Promise<void> {
  const { fail, lock } = keysFor(scope);
  await store().clear([fail, lock]);
}
