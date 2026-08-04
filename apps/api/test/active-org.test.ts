/**
 * Active-organization (`oid`) claim. POST /users/me/organizations/:id/switch
 * re-mints the token pair with an active org; read endpoints (entitlements)
 * then default to that org's view + shared pool without an explicit
 * organizationId. The active org persists across refresh and self-heals when
 * the user leaves the org. Clearing switches back to the personal pool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

describe('Active organization (oid claim)', () => {
  let app: FastifyInstance;
  let token: string; // tenant operator
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
        payload: { email: `ao-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'AO', slug: `ao-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['auth:write', 'billing:read'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  interface Session {
    accessToken: string;
    refreshToken: string;
    endUser: { id: string };
  }

  async function signUpUser(email: string): Promise<Session> {
    return app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: key(),
        payload: { email, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as Session);
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

  const entitlements = (accessToken: string) =>
    app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/entitlements',
        headers: { ...key(), 'x-rekey-user-token': accessToken },
      })
      .then((r) => r.json().data as { creditBalance: number });

  const switchTo = (accessToken: string, orgId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${orgId}/switch`,
      headers: { ...key(), 'x-rekey-user-token': accessToken },
    });

  const refresh = (refreshToken: string) =>
    app
      .inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: key(), payload: { refreshToken } })
      .then((r) => r.json().data as Session);

  it('switch defaults entitlements to the org pool; /users/me reports the active org', async () => {
    const owner = await signUpUser(`own-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(owner.endUser.id, 'acme');
    await creditsService.grant({ applicationId: appId, endUserId: owner.endUser.id, amount: 10, reason: 'GRANT' });
    await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 500, reason: 'GRANT' });

    // Before switching: personal pool.
    expect((await entitlements(owner.accessToken)).creditBalance).toBe(10);

    const switched = await switchTo(owner.accessToken, orgId).then((r) => r.json().data as Session);
    // After switching, no explicit organizationId → org pool via the oid claim.
    expect((await entitlements(switched.accessToken)).creditBalance).toBe(500);

    const me = await app
      .inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { ...key(), 'x-rekey-user-token': switched.accessToken },
      })
      .then((r) => r.json().data as { activeOrganizationId: string | null });
    expect(me.activeOrganizationId).toBe(orgId);
  });

  it('the active org survives refresh', async () => {
    const owner = await signUpUser(`r-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(owner.endUser.id, 'beta');
    await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 500, reason: 'GRANT' });

    const switched = await switchTo(owner.accessToken, orgId).then((r) => r.json().data as Session);
    const refreshed = await refresh(switched.refreshToken);
    expect((await entitlements(refreshed.accessToken)).creditBalance).toBe(500);
  });

  it('clearing the active org returns to the personal pool', async () => {
    const owner = await signUpUser(`c-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(owner.endUser.id, 'gamma');
    await creditsService.grant({ applicationId: appId, endUserId: owner.endUser.id, amount: 7, reason: 'GRANT' });
    await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 500, reason: 'GRANT' });

    const switched = await switchTo(owner.accessToken, orgId).then((r) => r.json().data as Session);
    expect((await entitlements(switched.accessToken)).creditBalance).toBe(500);

    const cleared = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/clear-active-organization',
        headers: { ...key(), 'x-rekey-user-token': switched.accessToken },
      })
      .then((r) => r.json().data as Session);
    expect((await entitlements(cleared.accessToken)).creditBalance).toBe(7);
  });

  it('refresh self-heals: leaving the org drops the active org', async () => {
    const owner = await signUpUser(`o-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const member = await signUpUser(`m-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(owner.endUser.id, 'delta');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/organizations/${orgId}/members`,
      headers: auth(),
      payload: { endUserId: member.endUser.id, role: 'MEMBER' },
    });
    await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 500, reason: 'GRANT' });

    const switched = await switchTo(member.accessToken, orgId).then((r) => r.json().data as Session);
    expect((await entitlements(switched.accessToken)).creditBalance).toBe(500); // member sees the shared pool

    // The member leaves the org (membership row gone), then refreshes.
    await prisma.organizationMembership.deleteMany({
      where: { organizationId: orgId, endUserId: member.endUser.id },
    });
    const refreshed = await refresh(switched.refreshToken);
    // Self-healed: no active org → member's personal pool (0).
    expect((await entitlements(refreshed.accessToken)).creditBalance).toBe(0);
    // …and the active org was cleared off the rotated refresh row.
    const row = await prisma.refreshToken.findFirstOrThrow({
      where: { endUserId: member.endUser.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.activeOrganizationId).toBeNull();
  });

  it('the EXISTING token stops reporting the org the moment membership ends', async () => {
    // The test above covers refresh. This covers the window before it: an
    // external audit removed a member and found `GET /users/me` still
    // returning the removed org as `activeOrganizationId` for the remaining
    // life of the access token, because the `oid` claim was echoed without
    // being checked. Authorization was never affected — org endpoints 403'd
    // correctly — but a UI driving "current team" off /users/me showed the
    // wrong team and then failed every call inside it.
    const owner = await signUpUser(`sv-own-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const member = await signUpUser(`sv-mem-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(owner.endUser.id, 'zeta');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/organizations/${orgId}/members`,
      headers: auth(),
      payload: { endUserId: member.endUser.id, role: 'MEMBER' },
    });
    await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 500, reason: 'GRANT' });

    const switched = await switchTo(member.accessToken, orgId).then((r) => r.json().data as Session);
    const meBefore = await app
      .inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { ...key(), 'x-rekey-user-token': switched.accessToken },
      })
      .then((r) => r.json().data as { activeOrganizationId: string | null });
    expect(meBefore.activeOrganizationId).toBe(orgId);

    // Removed — but deliberately NOT refreshed. The same access token is
    // reused below, which is the situation the audit was in.
    await prisma.organizationMembership.deleteMany({
      where: { organizationId: orgId, endUserId: member.endUser.id },
    });

    const meAfter = await app
      .inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { ...key(), 'x-rekey-user-token': switched.accessToken },
      })
      .then((r) => r.json().data as { activeOrganizationId: string | null });
    expect(meAfter.activeOrganizationId).toBeNull();

    // The token itself stays valid — removal from an organization is not a
    // reason to end a session — and the org's shared pool is no longer visible
    // through it, which is what the claim was defaulting the subject to.
    expect((await entitlements(switched.accessToken)).creditBalance).toBe(0);
  });

  it('a non-member cannot switch to the org (403)', async () => {
    const owner = await signUpUser(`x-own-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const outsider = await signUpUser(`x-out-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(owner.endUser.id, 'epsilon');
    const res = await switchTo(outsider.accessToken, orgId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
  });
});
