/**
 * Three ways entitlement resolution gave away what somebody was meant to pay
 * for. All three predate priced meters and were harmless while a quota only
 * capped; charging for usage past it turns each into revenue leaving.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';

describe('entitlement resolution — revenue leaks', () => {
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
        payload: { email: `lk-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'LK', slug: `lk-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug: 'calls', name: 'calls', unit: 'calls' },
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

  const makeEndUser = async (): Promise<string> =>
    app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email: `eu-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);

  /** A plan of any kind, with an optional USAGE allowance on `calls`. */
  async function makePlan(kind: string, included?: number): Promise<string> {
    const slug = `${kind.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`;
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: {
        slug,
        name: slug,
        amount: kind === 'SUBSCRIPTION' ? 0 : 500,
        kind,
        ...(kind === 'CREDIT' && { creditsAmount: 100 }),
        ...(kind === 'USAGE' && { meterSlug: 'calls', pricePerUnitCents: 1 }),
      },
    });
    if (included !== undefined) {
      await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
        headers: auth(),
        payload: { kind: 'USAGE', key: 'calls', quantity: included },
      });
    }
    return (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } })).id;
  }

  /** The free tier is `billingConfig.defaultPlanSlug`, not a column. */
  async function setDefaultPlan(planId: string): Promise<void> {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    const current = await prisma.application.findUniqueOrThrow({
      where: { id: appId },
      select: { billingConfig: true },
    });
    await prisma.application.update({
      where: { id: appId },
      data: {
        billingConfig: {
          ...(current.billingConfig as Record<string, unknown>),
          defaultPlanSlug: plan.slug,
        },
      },
    });
  }

  it('a credit purchase does not delete the free tier', async () => {
    // The free tier lives on the default plan and applies to users with no
    // recurring subscription. A CREDIT pack creates a Subscription row because
    // that is where provisioning hangs — it is not "being on a plan".
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);
    const eu = await makeEndUser();

    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 1000,
      creditsPerUnit: null,
    });

    const creditPlan = await makePlan('CREDIT');
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });

    // Still 1000. Before the fix this returned null — uncapped and unbilled.
    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 1000,
      creditsPerUnit: null,
    });
  });

  it('a real subscription does still replace the free tier', async () => {
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);
    const eu = await makeEndUser();

    const paid = await makePlan('SUBSCRIPTION', 50_000);
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: paid, status: 'ACTIVE' },
    });

    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 50_000,
      creditsPerUnit: null,
    });
  });

  it('an organization loses its quota when its subscription lapses', async () => {
    const org = await prisma.organization.create({
      data: { applicationId: appId, name: 'Acme', slug: `acme-${Math.random().toString(36).slice(2, 7)}` },
    });
    const planId = await makePlan('SUBSCRIPTION', 1000);
    const sub = await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: await makeEndUser(),
        beneficiaryOrgId: org.id,
        planId,
        status: 'ACTIVE',
      },
    });

    expect(await entitlementsService.includedQuotaFor(appId, { organizationId: org.id }, 'calls')).toEqual({
      included: 1000,
      creditsPerUnit: null,
    });

    // Lapsed yesterday. The personal branch has always honoured this; the org
    // branch filtered on status alone and kept the quota forever.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAt: new Date(Date.now() - 86_400_000) },
    });

    expect(await entitlementsService.includedQuotaFor(appId, { organizationId: org.id }, 'calls')).toBeNull();
  });

  it('refuses usage backdated out of the current quota period', async () => {
    const eu = await makeEndUser();
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: key(),
      payload: { meterSlug: 'calls', quantity: 1, endUserId: eu, occurredAt: lastMonth.toISOString() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('USAGE_OCCURRED_AT_TOO_OLD');
  });

  it('refuses usage stamped in the future', async () => {
    const eu = await makeEndUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: key(),
      payload: {
        meterSlug: 'calls',
        quantity: 1,
        endUserId: eu,
        occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('USAGE_OCCURRED_AT_IN_FUTURE');
  });

  it('still accepts a timestamp inside the current period', async () => {
    const eu = await makeEndUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: key(),
      payload: {
        meterSlug: 'calls',
        quantity: 1,
        endUserId: eu,
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
