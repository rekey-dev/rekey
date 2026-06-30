/**
 * Org-beneficiary billing (phase B): a subscription whose beneficiary is an
 * org grants a shared credit pool + feature access to the org's members.
 *
 * Owner pays/manages (endUserId); members benefit. Verifies provisioning to
 * the org pool, member-side feature resolution, and the operator billing route.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

describe('Org-beneficiary billing', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ob-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'OB', slug: `ob-${slug}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
  });

  async function makeEndUser(email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email, password: 'pw-one-two-three' },
    });
    return (r.json().data as { id: string }).id;
  }

  it('provisions to the org pool; members resolve team features; operator route reports it', async () => {
    // Plan with a shared credit grant + a feature flag.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug: 'team', name: 'Team', amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/team/entitlements`,
      headers: auth(),
      payload: { kind: 'CREDIT', quantity: 500 },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/team/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'team_dashboards', valueType: 'BOOL', value: 'true' },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'team' } });

    const ownerId = await makeEndUser(`owner-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const memberId = await makeEndUser(`member-${Math.random().toString(36).slice(2, 7)}@example.com`);

    // Org with the owner as OWNER, plus a MEMBER (operator routes).
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'Acme', slug: 'acme', ownerEndUserId: ownerId },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/organizations/${orgId}/members`,
      headers: auth(),
      payload: { endUserId: memberId, role: 'MEMBER' },
    });

    // An ACTIVE subscription whose beneficiary is the org (owner = ownerId).
    const sub = await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: ownerId,
        planId: plan.id,
        beneficiaryOrgId: orgId,
        status: 'ACTIVE',
        provider: 'stripe',
      },
    });

    await entitlementsService.provision({ subscription: sub });

    // Credits landed in the ORG pool, not the owner's personal balance.
    expect(await creditsService.getBalance(appId, { organizationId: orgId })).toBe(500);
    expect(await creditsService.getBalance(appId, { endUserId: ownerId })).toBe(0);

    // The org view sees the feature + pool.
    const orgView = await entitlementsService.resolveForOrg(appId, orgId);
    expect(orgView.features.team_dashboards).toBe(true);
    expect(orgView.creditBalance).toBe(500);

    // A plain MEMBER (no personal sub) sees the team feature via membership.
    const memberView = await entitlementsService.resolveForEndUser(appId, memberId);
    expect(memberView.features.team_dashboards).toBe(true);

    // A non-member end-user does NOT.
    const outsiderId = await makeEndUser(`out-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const outsiderView = await entitlementsService.resolveForEndUser(appId, outsiderId);
    expect(outsiderView.features.team_dashboards).toBeUndefined();

    // Operator billing route mirrors it.
    const opBilling = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appId}/organizations/${orgId}/billing`,
        headers: auth(),
      })
      .then((r) => r.json().data as { creditBalance: number; subscriptions: unknown[] });
    expect(opBilling.creditBalance).toBe(500);
    expect(opBilling.subscriptions).toHaveLength(1);
  });

  it('public credits consume draws from the org pool by organizationId', async () => {
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'Pool', slug: 'pool' },
      })
      .then((r) => (r.json().data as { id: string }).id);
    // Seed the org pool directly.
    await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 100, reason: 'GRANT' });

    // A live API key for the server-to-server credits endpoint, billing on.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/billing-config`,
      headers: auth(),
      payload: { enabled: true },
    });
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['billing:write'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/credits/consume',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { organizationId: orgId, amount: 40, idempotencyKey: 'job-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.balance).toBe(60);
    expect(await creditsService.getBalance(appId, { organizationId: orgId })).toBe(60);
  });
});
