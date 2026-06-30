/**
 * Org-pooled license key delivery (#27). An org-beneficiary subscription
 * provisions ONE pooled license but stores it hash-only — the auto-issued raw
 * key is discarded and can never be read back. That left org seats
 * provisionable but unusable: nobody could obtain a key to call
 * `licenses/verify`.
 *
 * The fix is an operator-gated rotate-key endpoint that mints a FRESH key for
 * the existing pooled license and returns it once. These tests prove the
 * operator can obtain a usable key for a provisioned org license and that
 * `licenses/verify` then succeeds across the org's seats.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';

describe('License — org-pooled key delivery (#27)', () => {
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

  const rotateUrl = (orgId: string, licenseId: string): string =>
    `/api/v1/tenant/applications/${appId}/organizations/${orgId}/licenses/${licenseId}/rotate-key`;

  const verify = (key: string, machineFingerprint: string) =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/licenses/verify',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { key, machineFingerprint },
      })
      .then((r) => r.json().data as { ok: boolean; reason?: string });

  it('operator obtains a usable key for a provisioned org license; verify then succeeds', async () => {
    // Provision an org-pooled SEATS license — exactly as a webhook activation
    // would. The raw key is discarded here (hash-only), so nobody holds it yet.
    const ownerId = await makeEndUser(`own-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(ownerId, 'acme');
    const planId = await makeSeatsPlan('team', 3);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: ownerId, planId, beneficiaryOrgId: orgId, status: 'ACTIVE', provider: 'stripe' },
    });
    await entitlementsService.provision({ subscription: sub });

    const pooled = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, organizationId: orgId } });

    // Before the fix this seat is unusable — there is no key to verify with.
    const res = await app.inject({ method: 'POST', url: rotateUrl(orgId, pooled.id), headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as { rawKey: string; activationsReset: number; license: { id: string; seatsAllowed: number } };
    expect(body.rawKey).toMatch(/^rl_lic_/);
    expect(body.activationsReset).toBe(0); // original key was never delivered
    expect(body.license.id).toBe(pooled.id);
    expect(body.license.seatsAllowed).toBe(3);

    // The returned key is usable: the team's machines can now verify against it,
    // sharing the org's seats and capping at seatsAllowed.
    expect((await verify(body.rawKey, 'm1')).ok).toBe(true);
    expect((await verify(body.rawKey, 'm2')).ok).toBe(true);
    expect((await verify(body.rawKey, 'm3')).ok).toBe(true);
    const fourth = await verify(body.rawKey, 'm4');
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe('seats_exhausted');
  });

  it('rotating again resets activations and invalidates the previous key', async () => {
    const ownerId = await makeEndUser(`rot-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(ownerId, 'rota');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: ownerId } });
    const license = await licensesService.issue({
      application,
      endUser,
      kind: 'SEATS',
      seatsAllowed: 2,
      organizationId: orgId,
    });

    // First key gets an activation.
    const first = await app
      .inject({ method: 'POST', url: rotateUrl(orgId, license.license.id), headers: auth() })
      .then((r) => r.json().data as { rawKey: string; activationsReset: number });
    expect((await verify(first.rawKey, 'machine-a')).ok).toBe(true);

    // Rotate again: the old key stops working and its activation is cleared.
    const second = await app
      .inject({ method: 'POST', url: rotateUrl(orgId, license.license.id), headers: auth() })
      .then((r) => r.json().data as { rawKey: string; activationsReset: number });
    expect(second.activationsReset).toBe(1);
    expect(second.rawKey).not.toBe(first.rawKey);
    expect((await verify(first.rawKey, 'machine-a')).ok).toBe(false); // old key dead
    expect((await verify(second.rawKey, 'machine-a')).ok).toBe(true); // new key live
  });

  it('refuses to rotate a personal (non-org) license via the org route', async () => {
    const euId = await makeEndUser(`solo-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(euId, 'solo-org');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: euId } });
    // Personal license — no organizationId.
    const personal = await licensesService.issue({ application, endUser, kind: 'PERPETUAL' });

    const res = await app.inject({ method: 'POST', url: rotateUrl(orgId, personal.license.id), headers: auth() });
    expect(res.statusCode).toBe(404);
    expect((res.json().error as { code: string }).code).toBe('LICENSE_NOT_FOUND');
  });

  it('refuses to rotate a revoked org license', async () => {
    const ownerId = await makeEndUser(`rev-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(ownerId, 'rev-org');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: ownerId } });
    const license = await licensesService.issue({ application, endUser, kind: 'SEATS', seatsAllowed: 1, organizationId: orgId });
    await licensesService.revoke(appId, license.license.id);

    const res = await app.inject({ method: 'POST', url: rotateUrl(orgId, license.license.id), headers: auth() });
    expect(res.statusCode).toBe(409);
    expect((res.json().error as { code: string }).code).toBe('LICENSE_REVOKED');
  });
});
