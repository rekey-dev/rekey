/**
 * A cross-replica lease for periodic background work.
 *
 * Every API replica starts the same interval timers. Work that is not safe or
 * not cheap to run N times at once (the prune sweep) takes this lease first
 * and skips the tick when another replica holds it.
 *
 * Acquire: `SET key token NX PX ttl`. The token is random per attempt, so the
 * holder can prove ownership later.
 *
 * Renew: while the work runs, the TTL is pushed forward every `ttlMs / 3`
 * with a compare-and-PEXPIRE. The TTL itself stays short, so a replica that
 * dies mid-sweep frees the lease within one TTL instead of blocking the sweep
 * for as long as the longest imaginable run. A long fixed TTL was rejected
 * because the sweep has no useful upper bound: the log archive uploads to S3
 * and a slow bucket stretches a run arbitrarily.
 *
 * Release: compare-and-delete in Lua, in `finally`. If this replica stalled
 * past its TTL and another replica took the lease, a plain DEL would delete
 * the other replica's lease and let a third one in. The script only deletes a
 * key that still holds our token.
 *
 * Redis unreachable: the tick is SKIPPED (fail closed). Skipping one sweep is
 * harmless, the next tick catches up. Running unleased on every replica is
 * what this exists to stop: N times the delete work, lock contention on the
 * busiest tables, and the same log rows archived into two objects, which
 * double-counts downstream. Redis is required at boot, so an outage long
 * enough to matter is already an incident.
 *
 * No Redis client at all (`getRedis()` is null only under NODE_ENV=test, which
 * is one process): the work runs unleased. There is nothing to coordinate
 * with, and the caller passes the null explicitly.
 */

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

/** The subset of ioredis the lease uses, so tests can hand in a failing client. */
export type LeaseRedis = Pick<Redis, 'set' | 'eval'>;

export interface LeaseOptions {
  key: string;
  ttlMs: number;
  /** Defaults to a third of the TTL, so two renewals can fail before expiry. */
  renewEveryMs?: number;
  /** Called when a renew or release command fails. The work is not interrupted. */
  onError?: (err: unknown, phase: 'renew' | 'release') => void;
}

export type LeaseOutcome<T> =
  | { status: 'ran'; result: T; leased: boolean }
  | { status: 'held' }
  | { status: 'redis-unavailable'; error: unknown };

export async function withLease<T>(
  redis: LeaseRedis | null,
  options: LeaseOptions,
  work: () => Promise<T>,
): Promise<LeaseOutcome<T>> {
  if (!redis) {
    return { status: 'ran', result: await work(), leased: false };
  }

  const token = randomBytes(16).toString('hex');
  let acquired: string | null;
  try {
    acquired = await redis.set(options.key, token, 'PX', options.ttlMs, 'NX');
  } catch (error) {
    return { status: 'redis-unavailable', error };
  }
  if (acquired !== 'OK') return { status: 'held' };

  const renewEveryMs = options.renewEveryMs ?? Math.max(1, Math.floor(options.ttlMs / 3));
  const renewTimer = setInterval(() => {
    redis
      .eval(RENEW_SCRIPT, 1, options.key, token, String(options.ttlMs))
      .catch((err: unknown) => options.onError?.(err, 'renew'));
  }, renewEveryMs);
  renewTimer.unref();

  try {
    return { status: 'ran', result: await work(), leased: true };
  } finally {
    clearInterval(renewTimer);
    try {
      await redis.eval(RELEASE_SCRIPT, 1, options.key, token);
    } catch (err) {
      // The TTL frees it; nothing else to do.
      options.onError?.(err, 'release');
    }
  }
}
