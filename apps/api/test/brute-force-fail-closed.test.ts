/**
 * Brute-force protection must fail CLOSED when its store is unavailable.
 *
 * The bug this pins: every Redis op used to be wrapped in a catch that returned
 * "0 / not locked". Two exploits fell out of that. Failed sign-ins stopped being
 * counted, so guessing was unlimited; and `lockTtl` reporting 0 meant an account
 * that was ALREADY locked read as unlocked, so an attacker who had tripped a
 * lockout was let straight back in. Protection was off precisely when a
 * dependency was flapping.
 *
 * The rule now: anything that could under-report attempts or under-report a lock
 * raises 503 DEPENDENCY_UNAVAILABLE, so authentication is briefly unavailable
 * rather than unprotected. The single exception is `clearFailures`, where a
 * failure leaves the scope MORE restricted and refusing a correct sign-in would
 * buy nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Controllable fake Redis. Each op either resolves or rejects on demand. */
const state = {
  failing: false,
  ttlValue: 0,
  incrValue: 1,
  getValue: null as string | null,
  client: null as unknown,
};

function makeClient() {
  const boom = () => Promise.reject(new Error('READONLY You cant write against a replica'));
  return {
    incr: () => (state.failing ? boom() : Promise.resolve(state.incrValue)),
    expire: () => (state.failing ? boom() : Promise.resolve(1)),
    set: () => (state.failing ? boom() : Promise.resolve('OK')),
    ttl: () => (state.failing ? boom() : Promise.resolve(state.ttlValue)),
    get: () => (state.failing ? boom() : Promise.resolve(state.getValue)),
    del: () => (state.failing ? boom() : Promise.resolve(1)),
  };
}

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => state.client,
  closeRedis: async () => {},
}));

const {
  assertNotLocked,
  registerFailure,
  clearFailures,
  getScopeLockState,
  euLoginLockScope,
  LOGIN_POLICY,
} = await import('../src/lib/brute-force.js');

describe('brute-force fails closed on a store outage', () => {
  beforeEach(() => {
    state.failing = false;
    state.ttlValue = 0;
    state.incrValue = 1;
    state.getValue = null;
    state.client = makeClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assertNotLocked raises 503 rather than treating an unreadable lock as unlocked', async () => {
    state.failing = true;
    // The exploit: this used to resolve silently, letting the caller proceed to
    // the credential check as though nothing were locked.
    await expect(assertNotLocked('eu:login:app:someone@example.com')).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });

  it('registerFailure raises 503 rather than dropping an attempt from the count', async () => {
    state.failing = true;
    await expect(
      registerFailure('eu:login:app:someone@example.com', LOGIN_POLICY),
    ).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('a genuine lockout still reports 429 with its own code, not 503', async () => {
    // Regression guard on the wrapper: it must rethrow a RekeyError untouched
    // rather than relabel a real lockout as a dependency outage.
    state.ttlValue = 42;
    await expect(
      assertNotLocked('eu:login:app:someone@example.com', 'MFA_TOO_MANY_ATTEMPTS'),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'MFA_TOO_MANY_ATTEMPTS',
      retryAfterSeconds: 42,
    });
  });

  it('clearFailures stays best-effort — a store error must not fail a correct sign-in', async () => {
    state.failing = true;
    // Failing to clear can only over-restrict, and the TTL removes the key
    // anyway. Refusing the sign-in here would be an outage for no security gain.
    await expect(clearFailures('eu:login:app:someone@example.com')).resolves.toBeUndefined();
  });

  it('the threshold still trips normally when the store is healthy', async () => {
    state.incrValue = LOGIN_POLICY.threshold;

    // `registerFailure` used to return void. It now reports the count and
    // whether this attempt tripped the lock, because the caller has to emit
    // `auth.sign_in_failed` / `auth.locked_out` and cannot re-derive either
    // without a second round-trip to the store.
    await expect(
      registerFailure('eu:login:app:someone@example.com', LOGIN_POLICY),
    ).resolves.toMatchObject({ failures: LOGIN_POLICY.threshold, locked: true });
  });

  it('refuses to run on process-local counters when there is no client in production', async () => {
    // Per-process counters would give N replicas N times the attempts, and a
    // restart would clear every lock. Production refuses to boot without
    // REDIS_URL, so reaching this is a bug worth surfacing, not a mode.
    state.client = null;
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(assertNotLocked('eu:login:app:someone@example.com')).rejects.toMatchObject({
        statusCode: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('still uses the in-memory store outside production, so tests stay deterministic', async () => {
    state.client = null;
    await expect(assertNotLocked('eu:login:app:nobody@example.com')).resolves.toBeUndefined();
  });
});

/**
 * `getScopeLockState` is the ONE read in this module that fails open, and that
 * is a deliberate exception rather than a relapse: it drives the operator
 * panel's lock badge, it gates nothing, and `assertNotLocked` is still refusing
 * every sign-in attempt during the same outage. 503-ing an entire end-user
 * detail page because Redis blipped would buy no security.
 */
describe('the display-only lock read fails open, and says so', () => {
  beforeEach(() => {
    state.failing = false;
    state.ttlValue = 0;
    state.incrValue = 1;
    state.getValue = null;
    state.client = makeClient();
  });

  it('answers null (unknown) rather than throwing when the store is down', async () => {
    state.failing = true;
    await expect(getScopeLockState('eu:login:app:someone@example.com')).resolves.toBeNull();
  });

  it('reports the remaining TTL for a locked scope', async () => {
    state.ttlValue = 600;
    await expect(getScopeLockState('eu:login:app:someone@example.com')).resolves.toEqual({
      lockedForSec: 600,
      failuresInWindow: 0,
    });
  });

  it('reports the live failure counter while a scope is still below the threshold', async () => {
    state.getValue = '4';
    await expect(getScopeLockState('eu:login:app:someone@example.com')).resolves.toEqual({
      lockedForSec: null,
      failuresInWindow: 4,
    });
  });

  it('derives its key exactly the way the writer does', async () => {
    // The failure mode this guards: a reader that builds the scope even
    // slightly differently gets a permanent miss and reports "not locked"
    // forever, which is exactly how the panel came to lie. One
    // exported builder, used by auth.service on write and the operator routes
    // on read, is the only reason that cannot drift.
    expect(euLoginLockScope('app_123', 'Someone@Example.COM')).toBe(
      'eu:login:app_123:someone@example.com',
    );
    // Case-folding matters because sign-in looks the row up case-insensitively:
    // a per-capitalisation counter would be a free reset for an attacker.
    expect(euLoginLockScope('app_123', 'someone@example.com')).toBe(
      euLoginLockScope('app_123', 'SOMEONE@EXAMPLE.COM'),
    );
  });

  it('a lock set by the real write path is visible to the read path', async () => {
    // End-to-end through the in-memory store: registerFailure crossing the
    // threshold must produce a lock that getScopeLockState can see, using only
    // the public API. The counter is consumed setting the lock, which is why
    // the operator surface reports the policy threshold rather than a count.
    state.client = null;
    const scope = euLoginLockScope('app_rt', 'roundtrip@example.com');
    for (let i = 0; i < LOGIN_POLICY.threshold; i++) {
      await registerFailure(scope, LOGIN_POLICY);
    }
    const locked = await getScopeLockState(scope);
    expect(locked?.lockedForSec).toBeGreaterThan(0);
    expect(locked?.failuresInWindow).toBe(0);

    await clearFailures(scope);
    expect(await getScopeLockState(scope)).toEqual({ lockedForSec: null, failuresInWindow: 0 });
  });
});

describe('the auth rate-limit tier fails closed too', () => {
  it('marks the auth ceiling and per-route auth caps skipOnError: false', async () => {
    // The global limiter keeps `skipOnError: true` on purpose — it protects
    // throughput, and failing it closed turns a Redis restart into a full
    // outage. The auth tier is different: `forgot-password` and
    // `magic-link/request` have no brute-force scope behind them (they are not
    // sign-in attempts), so a skipped limiter would accept unbounded requests,
    // each one sending an email.
    const { authCeilingOptions, authRateLimit } = await import('../src/lib/rate-limit.js');
    expect(authCeilingOptions(100, 60_000).skipOnError).toBe(false);
    expect(authRateLimit(10).skipOnError).toBe(false);
  });
});
