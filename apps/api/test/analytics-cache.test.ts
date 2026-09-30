/**
 * The Users overview through the real cache (REDIS_URL, provided in CI):
 * concurrent cold requests compute each section once, hits say so, and a
 * reporting-timezone change drops the Application's cached sections.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { __useRedisForTests } from '../src/lib/dashboard-cache.js';
import { kpisSection } from '../src/modules/analytics/sections/kpis.js';
import { activitySection } from '../src/modules/analytics/sections/activity.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import { allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { seedUsers } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RACERS = 20;

describe('users analytics cache', () => {
  let app: FastifyInstance;
  let redis: Redis;
  let w: OperatorWorld;

  beforeAll(async () => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    __useRedisForTests(redis);
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    __useRedisForTests(undefined);
    await app.close();
    await redis.quit();
  });
  beforeEach(async () => {
    const keys = await redis.keys('rk:an:*');
    if (keys.length) await redis.del(...keys);
    w = await operatorWorld(app);
    await seedUsers(w.appId, 50, 11);
  });

  const get = (qs = '?range=7d') =>
    w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/analytics/users${qs}`, headers: bearer(w.ownerToken) });

  it(`${RACERS} concurrent cold requests compute each section once`, async () => {
    const kpis = vi.spyOn(kpisSection, 'compute');
    const activity = vi.spyOn(activitySection, 'compute');
    try {
      const responses = await Promise.all(Array.from({ length: RACERS }, () => get()));
      for (const r of responses) {
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().data.sections.kpis.status).toBe('ok');
        expect(r.json().data.sections.activity.status).toBe('ok');
      }
      expect(kpis).toHaveBeenCalledTimes(1);
      expect(activity).toHaveBeenCalledTimes(1);
      const hits = responses.filter((r) => r.json().data.sections.kpis.cache.hit).length;
      expect(hits).toBe(RACERS - 1);
      const values = new Set(responses.map((r) => JSON.stringify(r.json().data.sections.kpis.data)));
      expect(values.size).toBe(1);
    } finally {
      kpis.mockRestore();
      activity.mockRestore();
    }
  });

  it('a different filter is a different entry; the same one is a hit', async () => {
    const first = await get('?range=7d&platform=ios');
    expect(first.json().data.sections.kpis.cache.hit).toBe(false);
    const again = await get('?range=7d&platform=ios');
    expect(again.json().data.sections.kpis.cache.hit).toBe(true);
    const other = await get('?range=7d&platform=web');
    expect(other.json().data.sections.kpis.cache.hit).toBe(false);
    const reordered = await get('?range=7d&platform=ios,web');
    const reordered2 = await get('?range=7d&platform=web,ios');
    expect(reordered.json().data.sections.kpis.cache.hit).toBe(false);
    expect(reordered2.json().data.sections.kpis.cache.hit).toBe(true);
  });

  it('a reporting-timezone change drops the cached sections', async () => {
    await get();
    expect((await get()).json().data.sections.kpis.cache.hit).toBe(true);
    const patched = await w.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${w.appId}/settings`,
      headers: bearer(w.ownerToken),
      payload: { reportingTimezone: 'Europe/Berlin' },
    });
    expect(patched.statusCode).toBe(200);
    await redis.ping();
    expect((await get()).json().data.sections.kpis.cache.hit).toBe(false);
  });

  it('the cached value is shared across callers and never holds who asked', async () => {
    await get();
    const member = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/analytics/users?range=7d`,
      headers: bearer(w.memberToken),
    });
    expect(member.json().data.sections.kpis.cache.hit).toBe(true);
    const keys = await redis.keys(`rk:an:users:v1:${w.appId}:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys.filter((x) => !x.endsWith(':lock'))) {
      const raw = (await redis.get(k)) ?? '';
      expect(raw).not.toContain('@example.com');
    }
  });

  it('turning billing on or off never serves the other state from cache', async () => {
    const off = await get('?range=7d&sections=billing');
    expect(off.json().data.sections.billing.status).toBe('unavailable');
    const current = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    await prisma.application.update({
      where: { id: w.appId },
      data: { billingConfig: { ...(current.billingConfig as object), enabled: true } },
    });
    const on = await get('?range=7d&sections=billing');
    expect(on.json().data.sections.billing.status).toBe('ok');
  });

  it('a named section the caller may not see is refused before any section is computed', async () => {
    await w.setScopes(['overview:read']);
    const kpis = vi.spyOn(kpisSection, 'compute');
    try {
      const res = await w.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${w.appId}/analytics/users?sections=kpis,billing`,
        headers: bearer(w.memberToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SCOPE_INSUFFICIENT');
      expect(kpis).not.toHaveBeenCalled();
    } finally {
      kpis.mockRestore();
    }
  });

  it('counts computations, not requests: cache hits never use up the allowance', async () => {
    const keys = await redis.keys('rk:an:computes:*');
    if (keys.length) await redis.del(...keys);
    for (let i = 0; i < 30; i++) {
      const r = await get(`?range=7d&sections=kpis&country=${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
      expect(r.statusCode, r.body).toBe(200);
    }
    const over = await get('?range=7d&sections=kpis&country=ZZ');
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) {
      const hit = await get('?range=7d&sections=kpis&country=AA');
      expect(hit.statusCode).toBe(200);
      expect(hit.json().data.sections.kpis.cache.hit).toBe(true);
    }
  });

  it('MCP calls draw on the same per-operator allowance as the REST route', async () => {
    const keys = await redis.keys('rk:an:computes:*');
    if (keys.length) await redis.del(...keys);
    const tool = allOperatorTools.find((t) => t.name === 'get_user_analytics')!;
    const application = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    const owner = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: application.tenantId, role: 'OWNER' } });
    const ctx = { tenantUserId: owner.tenantUserId, tenantId: application.tenantId, role: 'OWNER' as const, tenantMembershipId: owner.id, scopes: UNRESTRICTED, canWrite: false, canAdmin: false };
    const country = (i: number) => `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`;
    for (let i = 0; i < 20; i++) expect((await get(`?range=7d&sections=kpis&country=${country(i)}`)).statusCode).toBe(200);
    for (let i = 20; i < 30; i++) await tool.handler(ctx, { applicationId: w.appId, range: '7d', sections: 'kpis', country: country(i) });
    await expect(tool.handler(ctx, { applicationId: w.appId, range: '7d', sections: 'kpis', country: 'ZZ' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await get('?range=7d&sections=kpis&country=ZY')).statusCode).toBe(429);
  });
});
