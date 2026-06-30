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
});
