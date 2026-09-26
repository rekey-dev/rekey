/**
 * Concurrent accepts of one invitation: a double-clicked Accept button, or the
 * link opened in two tabs.
 *
 * Both accept paths (operator workspace invitations and end-user organization
 * invitations) read the invitation, then create the membership, and recover
 * from the unique violation of a concurrent accept by reading the winner's
 * membership. That read ran inside the transaction Postgres had already
 * aborted (25P02), so every loser answered 500.
 *
 * The documented intent in both services is that a concurrent accept by the
 * invited person converges on the one membership. A racer that arrives after
 * the winner committed sees the invitation as accepted, exactly like a replay
 * (400 NOT_USABLE). Either is fine; a 5xx is not.
 *
 * Eight racers, not two: two requests under `Promise.all` often do not overlap
 * in Postgres at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearOrganizationRoleCache } from '../src/lib/organization-role-cache.js';
import { POOL_SQUEEZE_TEST_TIMEOUT_MS, withPoolOf } from './pool-squeeze.js';

const RACERS = 8;

type Outcome = { status: number; code: string };

function summarize(results: Array<{ statusCode: number; json: () => unknown }>): Outcome[] {
  return results.map((r) => {
    const body = r.json() as { error?: { code: string } };
    return { status: r.statusCode, code: body.error?.code ?? 'ok' };
  });
}

describe('Concurrent invitation accepts', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  /** An operator invited to another workspace, ready to accept. */
  async function workspaceInvitation(tag: string) {
    const signUp = (email: string, workspaceName: string) =>
      app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/auth/sign-up',
          payload: { email, password: 'pw-one-two-three', workspaceName },
        })
        .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
    const owner = await signUp(`${tag}-owner@example.com`, `${tag} Owner Co`);
    const invitee = await signUp(`${tag}-invitee@example.com`, `${tag} Invitee Co`);
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/workspace/invitations',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { email: `${tag}-invitee@example.com`, role: 'MEMBER' },
      })
      .then((r) => (r.json().data as { token: string }).token);

    const accept = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/tenant/invitations/accept',
        headers: { authorization: `Bearer ${invitee.accessToken}` },
        payload: { token },
      });
    return { owner, accept, inviteeEmail: `${tag}-invitee@example.com` };
  }

  /** An end user invited to an organization, ready to accept. */
  async function organizationInvitation(tag: string) {
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${tag}-op@example.com`, password: 'pw-one-two-three', workspaceName: `${tag} WS` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: `${tag} App`, slug: `${tag}-app` },
      })
      .then((r) => r.json().data as { id: string });
    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          methods: ['password'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: true,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
        } as never,
      },
    });
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const endUser = (email: string) =>
      app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email, password: 'pw-one-two-three' },
        })
        .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    const owner = await endUser(`${tag}-owner@example.com`);
    const invitee = await endUser(`${tag}-invitee@example.com`);
    const as = (access: string) => ({ authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': access });

    const org = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: as(owner.accessToken),
        payload: { name: `${tag} Org`, slug: `${tag}-org` },
      })
      .then((r) => (r.json().data as { organization: { id: string } }).organization);
    const token = await app
      .inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.id}/invitations`,
        headers: as(owner.accessToken),
        payload: { email: `${tag}-invitee@example.com`, role: 'MEMBER' },
      })
      .then((r) => (r.json().data as { token: string }).token);

    const accept = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: as(invitee.accessToken),
        payload: { token },
      });
    return { org, invitee, accept };
  }

  it(`workspace invitation accepted in ${RACERS} tabs joins once, with no 5xx`, async () => {
    const { owner, accept, inviteeEmail } = await workspaceInvitation('race');
    const results = summarize(await Promise.all(Array.from({ length: RACERS }, accept)));

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r).toEqual({ status: 400, code: 'INVITATION_NOT_USABLE' });
    }
    const invitedUser = await prisma.tenantUser.findFirstOrThrow({ where: { email: inviteeEmail } });
    expect(
      await prisma.tenantMembership.count({
        where: { tenantId: owner.activeTenantId, tenantUserId: invitedUser.id },
      }),
    ).toBe(1);
  });

  it(`organization invitation accepted in ${RACERS} tabs joins once, with no 5xx`, async () => {
    const { org, invitee, accept } = await organizationInvitation('race-org');
    const results = summarize(await Promise.all(Array.from({ length: RACERS }, accept)));

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r).toEqual({ status: 400, code: 'ORGANIZATION_INVITATION_NOT_USABLE' });
    }
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: org.id, endUserId: invitee.endUser.id },
      }),
    ).toBe(1);
  });

  // Each accept transaction used to reach the global client once more (the
  // workspace refresh token was written through it, the organization role
  // catalog read through it), a second connection while the transaction held
  // the first. With one connection free that is a deadlock until the
  // transaction timeout.
  it('a workspace accept needs one pool connection, and its session commits with the membership', async () => {
    const { owner, accept, inviteeEmail } = await workspaceInvitation('pool-ws');
    const res = await withPoolOf(1, accept);
    expect(res.statusCode, res.body).toBe(200);
    const invitedUser = await prisma.tenantUser.findFirstOrThrow({ where: { email: inviteeEmail } });
    expect(
      await prisma.tenantMembership.count({
        where: { tenantId: owner.activeTenantId, tenantUserId: invitedUser.id },
      }),
    ).toBe(1);
  }, POOL_SQUEEZE_TEST_TIMEOUT_MS);

  it('an organization accept needs one pool connection', async () => {
    const { org, invitee, accept } = await organizationInvitation('pool-org');
    // A cold role catalog, as after every cache TTL: the read that used to run
    // inside the transaction then goes to the database.
    clearOrganizationRoleCache();
    const res = await withPoolOf(1, accept);
    expect(res.statusCode, res.body).toBe(200);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: org.id, endUserId: invitee.endUser.id },
      }),
    ).toBe(1);
  }, POOL_SQUEEZE_TEST_TIMEOUT_MS);
});
