/**
 * The free-tier default plan must cost nothing.
 *
 * `defaultPlanSlug` hands its FEATURE flags and included USAGE quota to every
 * signed-in end-user who has not bought anything. A live e2e run nominated a
 * 2000 USD/month plan through `PATCH .../billing-config`; it was accepted, and
 * every signed-in user got that plan's entitlements and quota for free, while
 * `POST /billing/subscribe` refused the same plan as BILLING_FREE_PLAN_NOT_FREE.
 *
 * Refused at every write that can set it, and ignored on read for a row that
 * got there anyway (written before this check, or repriced afterwards).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const PASSWORD = 'pw-one-two-three';
const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('the free-tier default plan must cost nothing', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let pubKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = `dp${Math.random().toString(36).slice(2, 7)}`;
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: auth(),
      payload: { name: 'DP', slug, enableBilling: true },
    });
    appId = (created.json().data as { id: string }).id;
    pubKey = (await prisma.application.findUniqueOrThrow({ where: { id: appId } })).publicKey;
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug: 'calls', name: 'Calls', unit: 'call' },
    });
  });

  /** A plan granting `reports: true` and 1000 included `calls`. */
  async function makePlan(body: Record<string, unknown>): Promise<string> {
    const slug = body.slug as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: body,
    });
    if (res.statusCode !== 201) throw new Error(`createPlan ${res.statusCode}: ${res.body}`);
    for (const ent of [
      { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' },
      { kind: 'USAGE', key: 'calls', quantity: 1000 },
    ]) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
        headers: auth(),
        payload: ent,
      });
      if (put.statusCode !== 200) throw new Error(`entitlement ${put.statusCode}: ${put.body}`);
    }
    return slug;
  }

  const priced = () => makePlan({ slug: 'pro', name: 'Pro', amount: 200_000, kind: 'SUBSCRIPTION' });
  const metered = () =>
    makePlan({ slug: 'metered', name: 'Metered', amount: 0, kind: 'USAGE', meterSlug: 'calls', pricePerUnitCents: 5 });
  const free = () => makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' });

  const tenantSet = (slug: string | null) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/billing-config`,
      headers: auth(),
      payload: { defaultPlanSlug: slug },
    });
  const adminSet = (slug: string | null) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/applications/${appId}/default-plan`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug },
    });

  async function storedDefault(): Promise<unknown> {
    const row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    return (row.billingConfig as Record<string, unknown>).defaultPlanSlug;
  }

  /** Bypass the write path, as a row written before the check would. */
  async function forceDefault(slug: string): Promise<void> {
    const row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: {
        billingConfig: { ...(row.billingConfig as Record<string, unknown>), defaultPlanSlug: slug } as Prisma.InputJsonValue,
      },
    });
  }

  async function signUp(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${pubKey}` },
      payload: { email: `u-${Math.random().toString(36).slice(2, 8)}@example.com`, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { accessToken: string }).accessToken;
  }

  async function whatAFreshUserGets(): Promise<{ features: Record<string, unknown>; calls: unknown }> {
    const userToken = await signUp();
    const headers = { authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': userToken };
    const ents = await app.inject({ method: 'GET', url: '/api/v1/billing/entitlements', headers });
    expect(ents.statusCode).toBe(200);
    const remaining = await app.inject({ method: 'GET', url: '/api/v1/usage/remaining', headers });
    expect(remaining.statusCode).toBe(200);
    const meters = (remaining.json().data as { meters: Array<{ meterSlug: string; included: unknown }> }).meters;
    return {
      features: (ents.json().data as { features: Record<string, unknown> }).features,
      calls: meters.find((m) => m.meterSlug === 'calls')?.included ?? null,
    };
  }

  describe('refused at write time', () => {
    it('tenant billing-config refuses a plan with a price', async () => {
      await priced();
      const res = await tenantSet('pro');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BILLING_FREE_PLAN_NOT_FREE');
      expect(await storedDefault()).toBeUndefined();
    });

    it('tenant billing-config refuses a plan that is free only in the headline', async () => {
      await metered();
      const res = await tenantSet('metered');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BILLING_FREE_PLAN_NOT_FREE');
      expect(await storedDefault()).toBeUndefined();
    });

    it('the super-admin default-plan route refuses it too', async () => {
      await priced();
      const res = await adminSet('pro');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BILLING_FREE_PLAN_NOT_FREE');
      expect(await storedDefault()).toBeUndefined();
    });

    it('still accepts a plan that costs nothing, and clearing', async () => {
      await free();
      expect((await tenantSet('free')).statusCode).toBe(200);
      expect(await storedDefault()).toBe('free');
      expect((await tenantSet(null)).statusCode).toBe(200);
      expect(await storedDefault()).toBeUndefined();
      expect((await adminSet('free')).statusCode).toBe(200);
      expect(await storedDefault()).toBe('free');
    });
  });

  describe('ignored on read', () => {
    it('a priced default already stored grants nothing, and says so once', async () => {
      await priced();
      await forceDefault('pro');

      const got = await whatAFreshUserGets();
      expect(got.features).toEqual({});
      expect(got.calls).toBeNull();

      const events = await waitForSecurityEvents({ applicationId: appId, type: 'app.default_plan_ignored' });
      expect(events[0]!.metadata).toMatchObject({ defaultPlanSlug: 'pro' });
    });

    it('a default repriced after nomination stops applying', async () => {
      await free();
      expect((await tenantSet('free')).statusCode).toBe(200);
      expect((await whatAFreshUserGets()).features).toEqual({ reports: true });

      await prisma.plan.update({
        where: { applicationId_slug: { applicationId: appId, slug: 'free' } },
        data: { amount: 900 },
      });
      const got = await whatAFreshUserGets();
      expect(got.features).toEqual({});
      expect(got.calls).toBeNull();
    });

    it('a free default keeps applying', async () => {
      await free();
      await forceDefault('free');
      const got = await whatAFreshUserGets();
      expect(got.features).toEqual({ reports: true });
      expect(got.calls).toBe(1000);
    });
  });
});
