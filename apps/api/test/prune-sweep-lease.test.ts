/**
 * The prune sweep runs on one replica at a time.
 *
 * Every API replica starts the same ten-minute timer. Without a shared lease
 * each one ran the full sweep: N times the delete work, lock contention on
 * refresh_tokens, and the same log rows archived into two different objects.
 *
 * These talk to a real Redis (REDIS_URL, provided in CI). `getRedis()` is null
 * under test by design, so the client is built here and passed in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { withLease, type LeaseRedis } from '../src/lib/sweep-lease.js';

const calls = vi.hoisted(() => ({ session: 0, gate: null as Promise<void> | null }));

vi.mock('../src/lib/token-prune.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/token-prune.js')>();
  return {
    ...actual,
    pruneExpiredSessionTokens: async () => {
      calls.session += 1;
      if (calls.gate) await calls.gate;
      return actual.pruneExpiredSessionTokens();
    },
  };
});

const { runPruneSweep } = await import('../src/lib/prune-sweep.js');

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
let redis: Redis;
let key: string;

const silent = { debug: () => undefined, warn: () => undefined };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeAll(() => {
  redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(() => {
  key = `lease:test:${Math.random().toString(36).slice(2)}`;
  calls.session = 0;
  calls.gate = null;
});

describe('prune sweep lease', () => {
  it('two sweeps started together do the work once', async () => {
    const gate = deferred();
    calls.gate = gate.promise;
    const options = {
      logRetentionDays: null,
      webhookEventRetentionDays: null,
      logArchiver: null,
      log: silent,
      leaseKey: key,
    };

    const first = runPruneSweep(redis, options);
    const second = runPruneSweep(redis, options);
    // Let both reach the lease before the first one finishes its work.
    await new Promise((r) => setTimeout(r, 100));
    gate.resolve();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['held', 'ran']);
    expect(calls.session).toBe(1);
    expect(await redis.get(key)).toBeNull();
  });

  it('releases the lease when the work throws', async () => {
    await expect(
      withLease(redis, { key, ttlMs: 60_000 }, async () => {
        expect(await redis.get(key)).not.toBeNull();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await redis.get(key)).toBeNull();
    // And the next sweep can take it straight away.
    const next = await withLease(redis, { key, ttlMs: 60_000 }, async () => 'ok');
    expect(next).toEqual({ status: 'ran', result: 'ok', leased: true });
  });

  it('never deletes a lease held by another token', async () => {
    // Our lease expires mid-work, another replica takes the key, then our
    // finally runs. A plain DEL would remove the other replica's lease.
    const outcome = await withLease(redis, { key, ttlMs: 50, renewEveryMs: 60_000 }, async () => {
      await new Promise((r) => setTimeout(r, 120));
      expect(await redis.get(key)).toBeNull();
      await redis.set(key, 'other-replica', 'PX', 60_000);
      return 'done';
    });

    expect(outcome.status).toBe('ran');
    expect(await redis.get(key)).toBe('other-replica');
    await redis.del(key);
  });

  it('renews the lease while a long sweep runs', async () => {
    await withLease(redis, { key, ttlMs: 150, renewEveryMs: 40 }, async () => {
      await new Promise((r) => setTimeout(r, 400));
      expect(await redis.get(key)).not.toBeNull();
    });
    expect(await redis.get(key)).toBeNull();
  });

  it('skips the tick when Redis is unreachable, rather than running unleased', async () => {
    const broken: LeaseRedis = {
      set: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as LeaseRedis['set'],
      eval: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as LeaseRedis['eval'],
    };
    const work = vi.fn(async () => 'ran');

    const outcome = await withLease(broken, { key, ttlMs: 60_000 }, work);

    expect(outcome.status).toBe('redis-unavailable');
    expect(work).not.toHaveBeenCalled();
  });

  it('runs unleased when there is no Redis client at all (single test process)', async () => {
    const outcome = await withLease(null, { key, ttlMs: 60_000 }, async () => 'ran');
    expect(outcome).toEqual({ status: 'ran', result: 'ran', leased: false });
  });
});
