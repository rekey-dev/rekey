/**
 * Plan entitlements — bundle CRUD + the in-house provisioner.
 *
 * Verifies: a plan can carry a bundle (CREDIT + LICENSE + FEATURE) via the
 * tenant CRUD route; provisioning a subscription materializes them onto the
 * subscriber; resolveForEndUser unions them (feature flags + credit balance);
 * provisioning is idempotent; and a legacy single-`kind` plan (no explicit
 * entitlements) still provisions from its kind fields.
 *
 * Each test bootstraps its own operator + app in beforeEach — the shared
 * setup.ts truncates all domain tables before every test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

describe('Plan entitlements + provisioner', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `ent-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    if (su.statusCode !== 201) throw new Error(`signup ${su.statusCode}: ${su.body}`);
    token = (su.json().data as { accessToken: string }).accessToken;
    const ac = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'EntApp', slug: `ent-${slug}` },
    });
    if (ac.statusCode !== 201) throw new Error(`appcreate ${ac.statusCode}: ${ac.body}`);
    appId = (ac.json().data as { id: string }).id;
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  async function makePlan(slug: string, body: Record<string, unknown>): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 0, ...body },
    });
    if (r.statusCode !== 201) throw new Error(`makePlan ${r.statusCode}: ${r.body}`);
    return (r.json().data as { id: string }).id;
  }

  async function makeEndUser(email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email, password: 'pw-one-two-three' },
    });
    if (r.statusCode !== 201) throw new Error(`makeEndUser ${r.statusCode}: ${r.body}`);
    return (r.json().data as { id: string }).id;
  }

  function putEntitlement(slug: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: body,
    });
  }

  it('attaches a bundle (CREDIT + LICENSE + FEATURE) via the tenant route', async () => {
    await makePlan('team', { kind: 'SUBSCRIPTION' });
    expect((await putEntitlement('team', { kind: 'CREDIT', quantity: 500 })).statusCode).toBe(200);
    expect(
      (await putEntitlement('team', { kind: 'LICENSE', licenseKind: 'SEATS', quantity: 5 })).statusCode,
    ).toBe(200);
    expect(
      (await putEntitlement('team', { kind: 'FEATURE', key: 'advanced_reporting', valueType: 'BOOL', value: 'true' }))
        .statusCode,
    ).toBe(200);

    const list = await app
      .inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/plans/team/entitlements`, headers: auth() })
      .then((r) => r.json().data as Array<{ kind: string }>);
    expect(list).toHaveLength(3);
  });

  it('rejects an invalid entitlement (FEATURE without value)', async () => {
    await makePlan('team', { kind: 'SUBSCRIPTION' });
    const r = await putEntitlement('team', { kind: 'FEATURE', key: 'x', valueType: 'BOOL' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('PLAN_ENTITLEMENT_INVALID');
  });

  it('provisions the bundle onto a subscriber + resolveForEndUser unions it (idempotent)', async () => {
    const planId = await makePlan('team', { kind: 'SUBSCRIPTION' });
    await putEntitlement('team', { kind: 'CREDIT', quantity: 500 });
    await putEntitlement('team', { kind: 'LICENSE', licenseKind: 'SEATS', quantity: 5 });
    await putEntitlement('team', { kind: 'FEATURE', key: 'advanced_reporting', valueType: 'BOOL', value: 'true' });

    const euId = await makeEndUser(`team-buyer-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });

    await entitlementsService.provision({ subscription: sub });

    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
    const lic = await prisma.license.findFirst({ where: { applicationId: appId, endUserId: euId, planId } });
    expect(lic?.kind).toBe('SEATS');
    expect(lic?.seatsAllowed).toBe(5);

    const resolved = await entitlementsService.resolveForEndUser(appId, euId);
    expect(resolved.features.advanced_reporting).toBe(true);
    expect(resolved.creditBalance).toBe(500);

    // Idempotent: provisioning again does not double-grant or duplicate the license.
    await entitlementsService.provision({ subscription: sub });
    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
    const licCount = await prisma.license.count({ where: { applicationId: appId, endUserId: euId, planId } });
    expect(licCount).toBe(1);
  });

  it('back-compat: a legacy single-kind CREDIT plan provisions from its kind fields', async () => {
    const planId = await makePlan('legacy-credits', { kind: 'CREDIT', creditsAmount: 100 });
    const euId = await makeEndUser(`legacy-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });
    await entitlementsService.provision({ subscription: sub });
    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(100);
  });

  describe('entitlementOverrides', () => {
    /** A subscription on a bare SUBSCRIPTION plan, with the given overrides. */
    async function subscribeWithOverrides(
      overrides: Record<string, unknown>,
      opts?: { planEntitlement?: Record<string, unknown>; status?: 'ACTIVE' | 'PAST_DUE' },
    ): Promise<{ euId: string }> {
      const planId = await makePlan('team', { kind: 'SUBSCRIPTION' });
      if (opts?.planEntitlement) await putEntitlement('team', opts.planEntitlement);
      const euId = await makeEndUser(`ovr-${Math.random().toString(36).slice(2, 7)}@example.com`);
      await prisma.subscription.create({
        data: {
          applicationId: appId,
          endUserId: euId,
          planId,
          status: opts?.status ?? 'ACTIVE',
          provider: 'stripe',
          entitlementOverrides: overrides as never,
        },
      });
      return { euId };
    }

    it('ADDS a FEATURE the plan does not carry', async () => {
      // The documented remedy for a customer who has outgrown their plan is an
      // override on their subscription. It could only ever rewrite a row the
      // plan already had — so for the common case, a plan carrying no such row
      // at all, setting the override changed precisely nothing and the
      // customer stayed capped. Both directions were reproduced.
      const { euId } = await subscribeWithOverrides({ 'FEATURE:max_workspaces': 3 });

      const resolved = await entitlementsService.resolveForEndUser(appId, euId);
      expect(resolved.features.max_workspaces).toBe(3);
    });

    it('still overrides a FEATURE the plan does carry', async () => {
      const { euId } = await subscribeWithOverrides(
        { 'FEATURE:max_workspaces': 7 },
        { planEntitlement: { kind: 'FEATURE', key: 'max_workspaces', valueType: 'INT', value: '1' } },
      );

      const resolved = await entitlementsService.resolveForEndUser(appId, euId);
      expect(resolved.features.max_workspaces).toBe(7);
    });

    it('types an added FEATURE by its value, so consumers get a number and not a string', async () => {
      const { euId } = await subscribeWithOverrides({
        'FEATURE:seats': 12,
        'FEATURE:beta': 'true',
        'FEATURE:tier': 'gold',
      });

      const resolved = await entitlementsService.resolveForEndUser(appId, euId);
      expect(resolved.features).toMatchObject({ seats: 12, beta: true, tier: 'gold' });
    });

    it('will NOT add a stateful entitlement — those materialize real grants', async () => {
      // A CREDIT/LICENSE/USAGE override is a bare number, so adding one would
      // mean inventing a licenceKind and a rollover policy and then handing out
      // whatever they turned out to mean. Adding those stays a plan decision.
      const { euId } = await subscribeWithOverrides({
        'CREDIT:': 500,
        'LICENSE:': 5,
        'USAGE:api_calls': 1000,
      });

      const resolved = await entitlementsService.resolveForEndUser(appId, euId);
      expect(resolved.entitlements).toHaveLength(0);
      expect(await entitlementsService.includedQuotaFor(appId, { endUserId: euId }, 'api_calls')).toBeNull();
    });
  });

  it('a PAST_DUE subscriber keeps the entitlements they bought (the dunning window)', async () => {
    // `isEntitledStatus` counts PAST_DUE, `getCurrentSubscription` returns it,
    // the portal shows the plan, and the whole point of dunning is to give the
    // customer time to fix their card. Resolving for ACTIVE only contradicted
    // all of that: the first failed charge silently stripped every feature
    // they had paid for, so a buyer of a three-workspace allowance was capped
    // at the default of one while their subscription was still live.
    const planId = await makePlan('team', { kind: 'SUBSCRIPTION' });
    await putEntitlement('team', { kind: 'FEATURE', key: 'max_workspaces', valueType: 'INT', value: '3' });
    await putEntitlement('team', { kind: 'USAGE', key: 'api_calls', quantity: 1000 });
    const euId = await makeEndUser(`dunning-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });

    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } });

    const resolved = await entitlementsService.resolveForEndUser(appId, euId);
    expect(resolved.features.max_workspaces).toBe(3);
    // Read the other way round, the same gap made a dunning customer UNMETERED
    // rather than under-entitled: no USAGE entitlement found resolves to
    // "uncapped".
    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: euId }, 'api_calls')).toBe(1000);
  });

  it('a CANCELED subscriber does not', async () => {
    // The fix must not over-apply: cancellation is terminal and is exactly
    // where entitlement stops.
    const planId = await makePlan('team', { kind: 'SUBSCRIPTION' });
    await putEntitlement('team', { kind: 'FEATURE', key: 'max_workspaces', valueType: 'INT', value: '3' });
    const euId = await makeEndUser(`gone-${Math.random().toString(36).slice(2, 7)}@example.com`);
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'CANCELED', provider: 'stripe' },
    });

    const resolved = await entitlementsService.resolveForEndUser(appId, euId);
    expect(resolved.features.max_workspaces).toBeUndefined();
  });
});
