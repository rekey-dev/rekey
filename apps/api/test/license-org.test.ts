/**
 * License org seats (owner+beneficiary, ORG_BILLING §3). An org-beneficiary
 * subscription provisions ONE license pooled to the org — its seats are shared
 * by the team's machines. The owner stays the holder (endUserId); a personal
 * sub still issues a personal (non-org) license. Verify is unchanged (key +
 * machine fingerprint, capped at seatsAllowed).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';

describe('License — org seats', () => {
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

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `lo-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'LO', slug: `lo-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
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

  async function makeSeatsPlan(slug: string, seats: number): Promise<string> {
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
      payload: { kind: 'LICENSE', licenseKind: 'SEATS', quantity: seats },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } });
    return plan.id;
  }

  async function makeOrg(ownerEndUserId: string, slug: string): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: slug, slug, ownerEndUserId },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  it('provisions one org-pooled SEATS license; idempotent; operator billing lists it', async () => {
    const ownerId = await makeEndUser(`own-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(ownerId, 'acme');
    const planId = await makeSeatsPlan('team', 3);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: ownerId, planId, beneficiaryOrgId: orgId, status: 'ACTIVE', provider: 'stripe' },
    });

    await entitlementsService.provision({ subscription: sub });

    const pooled = await prisma.license.findMany({ where: { applicationId: appId, organizationId: orgId } });
    expect(pooled).toHaveLength(1);
    expect(pooled[0]!.endUserId).toBe(ownerId); // owner is the holder
    expect(pooled[0]!.kind).toBe('SEATS');
    expect(pooled[0]!.seatsAllowed).toBe(3);

    // Idempotent: re-provision (renewal / webhook replay) does not duplicate.
    await entitlementsService.provision({ subscription: sub });
    expect(await prisma.license.count({ where: { applicationId: appId, organizationId: orgId } })).toBe(1);

    // Operator org-billing route surfaces the pooled seats.
    const billing = await app
      .inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/organizations/${orgId}/billing`, headers: auth() })
      .then((r) => r.json().data as { licenses: Array<{ seatsAllowed: number; kind: string }> });
    expect(billing.licenses).toHaveLength(1);
    expect(billing.licenses[0]!.seatsAllowed).toBe(3);
    expect(billing.licenses[0]!.kind).toBe('SEATS');
  });

  it('a personal sub issues a personal (non-org) license — no regression', async () => {
    const euId = await makeEndUser(`solo-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const planId = await makeSeatsPlan('solo', 1);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });
    await entitlementsService.provision({ subscription: sub });
    const lic = await prisma.license.findFirst({ where: { applicationId: appId, endUserId: euId, planId } });
    expect(lic).not.toBeNull();
    expect(lic!.organizationId).toBeNull();
  });

  it('org SEATS license shares seats across member machines, caps at seatsAllowed', async () => {
    const ownerId = await makeEndUser(`seat-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(ownerId, 'pool');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: ownerId } });
    const { rawKey } = await licensesService.issue({
      application,
      endUser,
      kind: 'SEATS',
      seatsAllowed: 2,
      organizationId: orgId,
    });

    const verify = (machineFingerprint: string) =>
      app
        .inject({
          method: 'POST',
          url: '/api/v1/licenses/verify',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { key: rawKey, machineFingerprint },
        })
        .then((r) => r.json().data as { ok: boolean; reason?: string });

    // Two distinct member machines each take a seat.
    expect((await verify('m1')).ok).toBe(true);
    expect((await verify('m2')).ok).toBe(true);
    // The third is refused — the org's two seats are full.
    const third = await verify('m3');
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('seats_exhausted');

    // The license is attributed to the org pool.
    const row = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, organizationId: orgId } });
    expect(row.organizationId).toBe(orgId);
  });
});
