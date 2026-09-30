/**
 * `lib/swr-cache.ts` against a real Redis (REDIS_URL, provided in CI).
 * `getRedis()` is null under NODE_ENV=test, so the client is handed in.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __useRedisForTests } from '../src/lib/dashboard-cache.js';
import { bumpCacheVersion, cachedSwr } from '../src/lib/swr-cache.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const KEY = 'rk:test:swr';
const VERSION = 'rk:test:swr:version';
const RACERS = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('stale-while-revalidate cache', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    __useRedisForTests(redis);
  });
  afterAll(async () => {
    __useRedisForTests(undefined);
    await redis.del(KEY, `${KEY}:v`, `${KEY}:lock`, VERSION);
    await redis.quit();
  });
  beforeEach(async () => {
    await redis.del(KEY, `${KEY}:v`, `${KEY}:lock`, VERSION);
  });

  it(`${RACERS} concurrent misses compute exactly once and all get the value`, async () => {
    let computes = 0;
    const compute = async (): Promise<number> => {
      computes += 1;
      await sleep(300);
      return 42;
    };
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => cachedSwr(KEY, { freshSeconds: 60, staleSeconds: 60, pollMs: 20 }, compute)),
    );
    expect(computes).toBe(1);
    for (const r of results) {
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.value).toBe(42);
    }
    expect(results.filter((r) => r.status === 'ok' && !r.cache.hit)).toHaveLength(1);
  });

  it('waiters get pending when the one computation outlives the wait', async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const compute = async (): Promise<string> => {
      computes += 1;
      await gate;
      return 'late';
    };
    const opts = { freshSeconds: 60, staleSeconds: 60, pollMs: 20, waitMs: 150 };
    const leader = cachedSwr(KEY, opts, compute);
    await sleep(30);
    const waiters = await Promise.all(Array.from({ length: 8 }, () => cachedSwr(KEY, opts, compute)));
    for (const w of waiters) expect(w).toEqual({ status: 'pending', retryAfterSeconds: 3 });
    release();
    expect((await leader).status).toBe('ok');
    expect(computes).toBe(1);
  });

  it('serves a stale value at once and refreshes it exactly once in the background', async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const opts = { freshSeconds: 0, staleSeconds: 60 };
    await cachedSwr(KEY, opts, async () => 'v1');
    const results = await Promise.all(
      Array.from({ length: RACERS }, () =>
        cachedSwr(KEY, opts, async () => {
          computes += 1;
          await gate;
          return 'v2';
        }),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.value).toBe('v1');
        expect(r.cache).toMatchObject({ hit: true, stale: true });
      }
    }
    release();
    await sleep(50);
    expect(computes).toBe(1);
    const after = await redis.get(KEY);
    expect(JSON.parse(after!).value).toBe('v2');
  });

  it('a fresh hit reports its age and does not recompute', async () => {
    let computes = 0;
    const compute = async (): Promise<number> => ++computes;
    await cachedSwr(KEY, { freshSeconds: 60, staleSeconds: 60 }, compute);
    const second = await cachedSwr(KEY, { freshSeconds: 60, staleSeconds: 60 }, compute);
    expect(computes).toBe(1);
    expect(second).toMatchObject({ status: 'ok', value: 1, cache: { hit: true, stale: false } });
  });

  it('bumping the version invalidates every entry under it, including one computing across the bump', async () => {
    const opts = { freshSeconds: 60, staleSeconds: 60, versionKey: VERSION };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inflight = cachedSwr(KEY, opts, async () => {
      await gate;
      return 'old';
    });
    await sleep(30);
    bumpCacheVersion(VERSION);
    await redis.ping();
    release();
    expect((await inflight).status).toBe('ok');
    const next = await cachedSwr(KEY, opts, async () => 'new');
    expect(next).toMatchObject({ status: 'ok', value: 'new', cache: { hit: false } });
  });

  it('a failing computation releases the lock so the next caller computes', async () => {
    const opts = { freshSeconds: 60, staleSeconds: 60 };
    await expect(
      cachedSwr(KEY, opts, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await redis.get(`${KEY}:lock`)).toBeNull();
    expect(await cachedSwr(KEY, opts, async () => 7)).toMatchObject({ status: 'ok', value: 7 });
  });

  it('fails open when Redis is unreachable', async () => {
    const dead = new Redis('redis://localhost:1', {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    dead.on('error', () => undefined);
    __useRedisForTests(dead);
    try {
      let computes = 0;
      const r = await cachedSwr(KEY, { freshSeconds: 60, staleSeconds: 60 }, async () => ++computes);
      expect(r).toMatchObject({ status: 'ok', value: 1, cache: { hit: false } });
    } finally {
      __useRedisForTests(redis);
      dead.disconnect();
    }
  });
});
