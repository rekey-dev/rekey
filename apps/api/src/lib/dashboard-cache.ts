/**
 * Short-lived Redis cache for dashboard aggregates.
 *
 * For read-only rollups the panel and the super-admin console render on every
 * page view (per-application stats, the super-admin overview). They are
 * counts over the largest tables in the database, the numbers are approximate
 * by nature, and a minute of lag on a dashboard tile is not a correctness
 * problem, so there is no invalidation beyond the TTL except where a value
 * the operator just changed is part of the payload (see `forgetDashboard`).
 *
 * Shared through Redis rather than held per process so N API replicas cost
 * one computation per key per TTL, not N. Fails open both ways: Redis absent
 * (NODE_ENV=test) or erroring means compute and return, never an error.
 *
 * Keys in use, all `rk:` prefixed:
 *   rk:stats:app:<applicationId>   GET /tenant/applications/:id/stats, 60s
 *   rk:admin:overview              GET /admin/metrics/overview, 60s
 */

import { getRedis } from './redis.js';

/**
 * Each key has a version counter beside it (`<key>:v`) that `forgetDashboard`
 * bumps. A value is stored tagged with the version read BEFORE it was
 * computed, and a read only accepts a value whose tag matches the current
 * version. So a computation that started before a `forgetDashboard` and
 * finished after it cannot put the old value back: its SET lands, but no
 * reader accepts it.
 */
const VERSION_TTL_SECONDS = 3600;

let testRedis: ReturnType<typeof getRedis> | undefined;
function redisClient(): ReturnType<typeof getRedis> {
  return testRedis !== undefined ? testRedis : getRedis();
}

interface Tagged<T> {
  v: string;
  value: T;
}

export async function cachedDashboard<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const redis = redisClient();
  let version: string | null = null;
  if (redis) {
    try {
      const [hit, v] = await redis.mget(key, `${key}:v`);
      version = v ?? '0';
      if (hit) {
        const tagged = JSON.parse(hit) as Tagged<T>;
        if (tagged.v === version) return tagged.value;
      }
    } catch {
      version = null; /* fall through to compute, and do not store */
    }
  }
  const value = await compute();
  if (redis && version !== null) {
    const tagged: Tagged<T> = { v: version, value };
    void redis.set(key, JSON.stringify(tagged), 'EX', ttlSeconds).catch(() => undefined);
  }
  return value;
}

/** Drop one key, for a write that changes a value the cached payload carries. */
export function forgetDashboard(key: string): void {
  const redis = redisClient();
  if (!redis) return;
  void redis
    .multi()
    .incr(`${key}:v`)
    .expire(`${key}:v`, VERSION_TTL_SECONDS)
    .del(key)
    .exec()
    .catch(() => undefined);
}

/** Point the cache at a real client (or back to `getRedis()` with `undefined`). */
export function __useRedisForTests(client: unknown): void {
  testRedis = client as ReturnType<typeof getRedis> | undefined;
}
