/**
 * Usage record idempotency (BUG-2). POST /api/v1/usage/record accepts an
 * OPTIONAL `idempotencyKey`. A retried call with the same (meter, key) returns
 * the ORIGINAL UsageRecord — it does not double-count usage, and (under a
 * bundled quota) charges the quota only once. No key → each call counts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('Usage — record idempotency', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const key = (): { authorization: string } => ({ authorization: `Bearer ${liveKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ui-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'UI', slug: `ui-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['billing:write'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  const record = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/usage/record', headers: key(), payload });

  async function makeEndUser(email: string): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  async function totalFor(endUserId?: string): Promise<{ total: number; count: number }> {
    const meter = await prisma.usageMeter.findFirstOrThrow({ where: { applicationId: appId, slug: 'api_calls' } });
    const agg = await prisma.usageRecord.aggregate({
      _sum: { quantity: true },
      _count: true,
      where: { meterId: meter.id, ...(endUserId && { endUserId }) },
    });
    return { total: agg._sum.quantity ?? 0, count: agg._count };
  }

  it('same idempotencyKey twice → one record, returns the original', async () => {
    const r1 = await record({ meterSlug: 'api_calls', quantity: 5, idempotencyKey: 'evt-1' });
    expect(r1.statusCode).toBe(201);
    const id1 = (r1.json().data as { id: string }).id;

    const r2 = await record({ meterSlug: 'api_calls', quantity: 5, idempotencyKey: 'evt-1' });
    expect(r2.statusCode).toBe(201);
    const id2 = (r2.json().data as { id: string }).id;

    // Same row returned, not a new insert.
    expect(id2).toBe(id1);
    const { total, count } = await totalFor();
    expect(total).toBe(5);
    expect(count).toBe(1);
  });

  it('a replayed quantity does not double-charge the included quota', async () => {
    const euId = await makeEndUser(`idemcap-${Math.random().toString(36).slice(2, 7)}@example.com`);
    // Plan with a 10-unit included quota.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug: 'capped', name: 'capped', amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/capped/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'api_calls', quantity: 10 },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'capped' } });
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId: plan.id, status: 'ACTIVE', provider: 'stripe' },
    });

    // Record 8 with a key; replay it; then 2 more — total must be 10 (not 18).
    expect((await record({ meterSlug: 'api_calls', quantity: 8, endUserId: euId, idempotencyKey: 'k8' })).statusCode).toBe(201);
    expect((await record({ meterSlug: 'api_calls', quantity: 8, endUserId: euId, idempotencyKey: 'k8' })).statusCode).toBe(201);
    expect((await record({ meterSlug: 'api_calls', quantity: 2, endUserId: euId })).statusCode).toBe(201);

    const { total } = await totalFor(euId);
    expect(total).toBe(10);
    // The quota is now exactly full — one more unit is refused.
    const over = await record({ meterSlug: 'api_calls', quantity: 1, endUserId: euId });
    expect(over.statusCode).toBe(402);
    expect(over.json().error.code).toBe('USAGE_QUOTA_EXCEEDED');
  });

  it('different keys → two records', async () => {
    expect((await record({ meterSlug: 'api_calls', quantity: 3, idempotencyKey: 'a' })).statusCode).toBe(201);
    expect((await record({ meterSlug: 'api_calls', quantity: 4, idempotencyKey: 'b' })).statusCode).toBe(201);
    const { total, count } = await totalFor();
    expect(total).toBe(7);
    expect(count).toBe(2);
  });

  it('no key → each call counts (historical behavior preserved)', async () => {
    expect((await record({ meterSlug: 'api_calls', quantity: 2 })).statusCode).toBe(201);
    expect((await record({ meterSlug: 'api_calls', quantity: 2 })).statusCode).toBe(201);
    const { total, count } = await totalFor();
    expect(total).toBe(4);
    expect(count).toBe(2);
  });

  it('a concurrent replay (same key) still yields a single record', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => record({ meterSlug: 'api_calls', quantity: 1, idempotencyKey: 'race' })),
    );
    for (const r of results) expect(r.statusCode).toBe(201);
    const ids = new Set(results.map((r) => (r.json().data as { id: string }).id));
    expect(ids.size).toBe(1);
    const { total, count } = await totalFor();
    expect(total).toBe(1);
    expect(count).toBe(1);
  });
});
