/**
 * `lib/dashboard-cache.ts` against a real Redis (REDIS_URL, provided in CI).
 * `getRedis()` is null under NODE_ENV=test, so the client is handed in.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __useRedisForTests, cachedDashboard, forgetDashboard } from '../src/lib/dashboard-cache.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const KEY = 'rk:test:dashboard';

describe('dashboard cache', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    __useRedisForTests(redis);
  });
  afterAll(async () => {
    __useRedisForTests(undefined);
    await redis.del(KEY, `${KEY}:v`);
    await redis.quit();
  });
  beforeEach(async () => {
    await redis.del(KEY, `${KEY}:v`);
  });

  const settled = async (): Promise<void> => {
    // The SET and the forget are fire-and-forget; a PING queues behind them.
    await redis.ping();
  };

  it('computes once per TTL', async () => {
    let n = 0;
    expect(await cachedDashboard(KEY, 60, async () => ++n)).toBe(1);
    await settled();
    expect(await cachedDashboard(KEY, 60, async () => ++n)).toBe(1);
    expect(n).toBe(1);
  });

  it('forget makes the next read recompute', async () => {
    let n = 0;
    await cachedDashboard(KEY, 60, async () => ++n);
    await settled();
    forgetDashboard(KEY);
    await settled();
    expect(await cachedDashboard(KEY, 60, async () => ++n)).toBe(2);
  });

  it('a computation that started before a forget cannot put its old value back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stale = cachedDashboard(KEY, 60, async () => {
      await gate;
      return 'old';
    });
    // Let it read the version before the forget lands.
    await new Promise((r) => setTimeout(r, 20));
    forgetDashboard(KEY);
    await settled();
    release();
    expect(await stale).toBe('old');
    await settled();
    // Its SET landed, but tagged with the old version: not served.
    expect(await cachedDashboard(KEY, 60, async () => 'new')).toBe('new');
  });
});
