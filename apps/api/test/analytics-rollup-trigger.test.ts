/**
 * The rollup a reporting-timezone change triggers: rapid changes coalesce to
 * one running and one pending run per Application, the pending run reads the
 * latest zone, triggered runs on one replica go one at a time, and a lease
 * held by another replica leaves a pending flag instead of a second run.
 */

import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { __useRedisForTests } from '../src/lib/dashboard-cache.js';
import { __setTriggeredRollupForTests, requestRollup } from '../src/modules/analytics/rollup/trigger.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RACERS = 10;
const ZONES = ['Asia/Tokyo', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'UTC'];
const silent = { warn: () => undefined };

interface Recorder {
  runs: Array<{ applicationId: string; zone: string }>;
  maxConcurrent: number;
  active: number;
}

function recordRuns(delayMs = 150): Recorder {
  const rec: Recorder = { runs: [], maxConcurrent: 0, active: 0 };
  __setTriggeredRollupForTests(async (applicationId) => {
    rec.active += 1;
    rec.maxConcurrent = Math.max(rec.maxConcurrent, rec.active);
    const app = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, select: { reportingTimezone: true } });
    rec.runs.push({ applicationId, zone: app.reportingTimezone });
    await new Promise((r) => setTimeout(r, delayMs));
    rec.active -= 1;
  });
  return rec;
}

async function settled(rec: Recorder): Promise<void> {
  let seen = -1;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (rec.active === 0 && rec.runs.length === seen) return;
    seen = rec.runs.length;
  }
}

describe('analytics rollup trigger', () => {
  let app: FastifyInstance;
  let redis: Redis;
  let w: OperatorWorld;

  beforeAll(async () => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await redis.quit();
  });
  beforeEach(async () => {
    const keys = [...(await redis.keys('rk:an:rollup-pending:*')), ...(await redis.keys('lease:analytics-rollup:app:*'))];
    if (keys.length) await redis.del(...keys);
    w = await operatorWorld(app);
  });
  afterEach(() => {
    __setTriggeredRollupForTests();
    __useRedisForTests(undefined);
  });

  const patch = (zone: string) =>
    w.inject({ method: 'PATCH', url: `/api/v1/tenant/applications/${w.appId}/settings`, headers: bearer(w.ownerToken), payload: { reportingTimezone: zone } });

  for (const withRedis of [true, false]) {
    it(`${RACERS} rapid zone changes start at most one run and one pending run, and the last reads the latest zone (${withRedis ? 'Redis' : 'no Redis'})`, async () => {
      if (withRedis) __useRedisForTests(redis);
      const rec = recordRuns();
      const responses = await Promise.all(Array.from({ length: RACERS }, (_, i) => patch(ZONES[i % ZONES.length]!)));
      for (const r of responses) expect(r.statusCode, r.body).toBe(200);
      await settled(rec);
      expect(rec.maxConcurrent).toBe(1);
      expect(rec.runs.length).toBeGreaterThanOrEqual(1);
      expect(rec.runs.length).toBeLessThanOrEqual(2);
      const final = await prisma.application.findUniqueOrThrow({ where: { id: w.appId }, select: { reportingTimezone: true } });
      expect(rec.runs.at(-1)?.zone).toBe(final.reportingTimezone);
    });
  }

  it('triggered runs for different Applications go one at a time on a replica', async () => {
    __useRedisForTests(redis);
    const rec = recordRuns(50);
    const others = await Promise.all(Array.from({ length: 7 }, () => operatorWorld(app)));
    await Promise.all([w, ...others].map((o) => requestRollup(o.appId, silent)));
    expect(rec.runs.length).toBe(8);
    expect(rec.maxConcurrent).toBe(1);
  });

  it('a lease held by another replica leaves a pending flag for it instead of running here', async () => {
    __useRedisForTests(redis);
    const rec = recordRuns(10);
    await redis.set(`lease:analytics-rollup:app:${w.appId}`, 'other-replica', 'PX', 30_000);
    await requestRollup(w.appId, silent);
    expect(rec.runs).toHaveLength(0);
    expect(await redis.exists(`rk:an:rollup-pending:${w.appId}`)).toBe(1);
    await redis.del(`lease:analytics-rollup:app:${w.appId}`);
    await requestRollup(w.appId, silent);
    expect(rec.runs).toHaveLength(1);
    expect(await redis.exists(`rk:an:rollup-pending:${w.appId}`)).toBe(0);
  });

  it('a request from another replica just after the last pending check still gets its run', async () => {
    let dels = 0;
    const racing = new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop !== 'del') return Reflect.get(target, prop, receiver);
        return async (...keys: string[]) => {
          const n = await target.del(...keys);
          dels += 1;
          // Another replica's request lands between this replica's last check and its release.
          if (dels === 2) await target.set(`rk:an:rollup-pending:${w.appId}`, '1', 'EX', 60);
          return n;
        };
      },
    });
    __useRedisForTests(racing);
    const rec = recordRuns(10);
    await requestRollup(w.appId, silent);
    expect(rec.runs).toHaveLength(2);
  });
});
