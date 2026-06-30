/**
 * Usage included-quota hard cap (BILLING_MODEL §7). A plan that bundles a USAGE
 * entitlement (meter + included units) caps consumption for the calendar month:
 * once the subject's usage would exceed the included quota, record returns 402
 * USAGE_QUOTA_EXCEEDED. No bundled quota → uncapped. Pooling: an org-beneficiary
 * sub caps the org pool, never a member's personal pool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('Usage — included-quota hard cap', () => {
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
        payload: { email: `uq-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'UQ', slug: `uq-${slug}`, enableBilling: true },
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

  /** Create a plan with a single USAGE entitlement and return its id. */
  async function makeCappedPlan(slug: string, included: number): Promise<string> {
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'api_calls', quantity: included },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } });
    return plan.id;
  }

  const record = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/usage/record', headers: key(), payload });

  it('caps an end-user at the included quota; exactly-at-quota is allowed', async () => {
    const euId = await makeEndUser(`cap-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const planId = await makeCappedPlan('capped', 10);
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });

    expect((await record({ meterSlug: 'api_calls', quantity: 7, endUserId: euId })).statusCode).toBe(201);
    // 7 + 3 = 10 == included → allowed (cap is "exceed", not "reach").
    expect((await record({ meterSlug: 'api_calls', quantity: 3, endUserId: euId })).statusCode).toBe(201);

    const over = await record({ meterSlug: 'api_calls', quantity: 1, endUserId: euId });
    expect(over.statusCode).toBe(402);
    expect(over.json().error.code).toBe('USAGE_QUOTA_EXCEEDED');
  });

  it('concurrent records cannot blow past the hard cap (check+insert is atomic)', async () => {
    const euId = await makeEndUser(`race-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const planId = await makeCappedPlan('raced', 5);
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });

    // 10 parallel 1-unit records against a 5-unit quota. Without the
    // meter-row lock, every request reads the pre-insert SUM and all pass.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        record({ meterSlug: 'api_calls', quantity: 1, endUserId: euId }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 201).length;
    const refused = results.filter((r) => r.statusCode === 402).length;
    expect(ok).toBe(5);
    expect(refused).toBe(5);

    const meter = await prisma.usageMeter.findFirstOrThrow({
      where: { applicationId: appId, slug: 'api_calls' },
    });
    const agg = await prisma.usageRecord.aggregate({
      _sum: { quantity: true },
      where: { meterId: meter.id, endUserId: euId },
    });
    expect(agg._sum.quantity).toBe(5);
  });

  it('does not cap a subject with no bundled USAGE quota', async () => {
    const euId = await makeEndUser(`free-${Math.random().toString(36).slice(2, 7)}@example.com`);
    // No subscription → no included quota → unmetered.
    expect((await record({ meterSlug: 'api_calls', quantity: 9999, endUserId: euId })).statusCode).toBe(201);
  });

  it('caps the org pool; a member-owner personal pool stays uncapped', async () => {
    const ownerId = await makeEndUser(`own-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'Acme', slug: 'acme', ownerEndUserId: ownerId },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const planId = await makeCappedPlan('team', 5);
    // Owner pays; beneficiary is the org → quota pools to the org.
    await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: ownerId,
        planId,
        beneficiaryOrgId: orgId,
        status: 'ACTIVE',
        provider: 'stripe',
      },
    });

    expect((await record({ meterSlug: 'api_calls', quantity: 5, organizationId: orgId })).statusCode).toBe(201);
    const orgOver = await record({ meterSlug: 'api_calls', quantity: 1, organizationId: orgId });
    expect(orgOver.statusCode).toBe(402);
    expect(orgOver.json().error.code).toBe('USAGE_QUOTA_EXCEEDED');

    // The org sub pools to the org, not the owner's personal pool — owner's own
    // (subject-less of org) usage is uncapped.
    expect((await record({ meterSlug: 'api_calls', quantity: 100, endUserId: ownerId })).statusCode).toBe(201);
  });
});
