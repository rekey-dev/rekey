/**
 * An OWNER or ADMIN can see the invitations nobody has answered yet, revoke
 * one from that list, and resend one with a fresh link. The list never
 * carries a token, and a member of one organization cannot reach another's.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { as, endUser, invite, member, orgApp } from './organization-fixtures.js';

operatorsConfirmTheirEmail();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const listUrl = (orgId: string) => `/api/v1/users/me/organizations/${orgId}/invitations`;

describe('listing pending invitations', () => {
  it('returns each pending invitation with its inviter, and never a token', async () => {
    const o = await orgApp(app, 'pend-list');
    const first = await invite(app, o, o.owner, 'first@example.com', 'ADMIN');
    const second = await invite(app, o, o.owner, 'second@example.com');
    const accepted = await endUser(app, o, 'accepted@example.com');
    const acceptedInv = await invite(app, o, o.owner, 'accepted@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: as(o, accepted),
      payload: { token: acceptedInv.token },
    });

    const res = await app.inject({ method: 'GET', url: listUrl(o.organizationId), headers: as(o, o.owner) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(first.token);
    expect(res.body).not.toContain(second.token);
    expect(res.body).not.toMatch(/token/i);
    const data = res.json().data as { items: Array<Record<string, unknown>>; page: { total: number } };
    expect(data.page.total).toBe(2);
    expect(data.items.map((i) => i.email)).toEqual(['second@example.com', 'first@example.com']);
    expect(Object.keys(data.items[1]!).sort()).toEqual(
      ['createdAt', 'email', 'expiresAt', 'id', 'invitedBy', 'organizationId', 'role'].sort(),
    );
    expect(data.items[1]).toMatchObject({
      id: first.invitation.id,
      role: 'ADMIN',
      invitedBy: { endUserId: o.owner.id, email: o.owner.email },
    });
  });

  it('revokes from the list by id, after which the invitation is gone from it and its link is dead', async () => {
    const o = await orgApp(app, 'pend-revoke');
    const invitee = await endUser(app, o, 'gone@example.com');
    const inv = await invite(app, o, o.owner, 'gone@example.com');
    const listed = await app.inject({ method: 'GET', url: listUrl(o.organizationId), headers: as(o, o.owner) });
    const id = (listed.json().data.items as Array<{ id: string }>)[0]!.id;

    const revoke = await app.inject({
      method: 'POST',
      url: `${listUrl(o.organizationId)}/${id}/revoke`,
      headers: as(o, o.owner),
    });
    expect(revoke.json().data).toEqual({ revoked: true });
    const after = await app.inject({ method: 'GET', url: listUrl(o.organizationId), headers: as(o, o.owner) });
    expect(after.json().data.items).toEqual([]);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: as(o, invitee),
      payload: { token: inv.token },
    });
    expect(accept.json().error.code).toBe('ORGANIZATION_INVITATION_NOT_USABLE');
  });

  it('an ADMIN may list; a plain member may neither list nor revoke', async () => {
    const o = await orgApp(app, 'pend-tiers');
    const admin = await member(app, o, 'admin@example.com', 'ADMIN');
    const plain = await member(app, o, 'plain@example.com');
    const inv = await invite(app, o, o.owner, 'someone@example.com');

    const byAdmin = await app.inject({ method: 'GET', url: listUrl(o.organizationId), headers: as(o, admin) });
    expect(byAdmin.statusCode).toBe(200);
    const byMember = await app.inject({ method: 'GET', url: listUrl(o.organizationId), headers: as(o, plain) });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');
    const revoke = await app.inject({
      method: 'POST',
      url: `${listUrl(o.organizationId)}/${inv.invitation.id}/revoke`,
      headers: as(o, plain),
    });
    expect(revoke.statusCode).toBe(403);
    const resend = await app.inject({
      method: 'POST',
      url: `${listUrl(o.organizationId)}/${inv.invitation.id}/resend`,
      headers: as(o, plain),
    });
    expect(resend.statusCode).toBe(403);
  });

  it("an owner of one organization cannot list, revoke or resend another's invitations", async () => {
    const o = await orgApp(app, 'pend-cross-org');
    const otherOwner = await endUser(app, o, 'other-owner@example.com');
    const other = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: as(o, otherOwner),
        payload: { name: 'Other', slug: 'other' },
      })
      .then((r) => r.json().data as { organization: { id: string } });
    const theirs = await invite(app, o, otherOwner, 'theirs@example.com', 'MEMBER', other.organization.id);

    const list = await app.inject({ method: 'GET', url: listUrl(other.organization.id), headers: as(o, o.owner) });
    expect(list.statusCode).toBe(403);
    expect(list.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
    for (const verb of ['revoke', 'resend']) {
      const viaOwn = await app.inject({
        method: 'POST',
        url: `${listUrl(o.organizationId)}/${theirs.invitation.id}/${verb}`,
        headers: as(o, o.owner),
      });
      expect(viaOwn.statusCode).toBe(404);
      expect(viaOwn.json().error.code).toBe('ORGANIZATION_INVITATION_NOT_FOUND');
    }
  });

  it("an owner in another Application cannot list this one's invitations", async () => {
    const o = await orgApp(app, 'pend-app-a');
    const elsewhere = await orgApp(app, 'pend-app-b');
    await invite(app, o, o.owner, 'x@example.com');
    const res = await app.inject({
      method: 'GET',
      url: listUrl(o.organizationId),
      headers: as(elsewhere, elsewhere.owner),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
  });
});

describe('resending an invitation', () => {
  it('issues a fresh link, kills the old one, and the fresh one accepts', async () => {
    const o = await orgApp(app, 'resend-ok');
    const invitee = await endUser(app, o, 'again@example.com');
    const old = await invite(app, o, o.owner, 'again@example.com', 'ADMIN');

    const res = await app.inject({
      method: 'POST',
      url: `${listUrl(o.organizationId)}/${old.invitation.id}/resend`,
      headers: as(o, o.owner),
    });
    expect(res.statusCode).toBe(201);
    const fresh = res.json().data as { token: string; invitation: { id: string; email: string; role: string } };
    expect(fresh.token).not.toBe(old.token);
    expect(fresh.invitation).toMatchObject({ email: 'again@example.com', role: 'ADMIN' });
    expect(fresh.invitation.id).not.toBe(old.invitation.id);

    const listed = await app.inject({ method: 'GET', url: listUrl(o.organizationId), headers: as(o, o.owner) });
    expect((listed.json().data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([fresh.invitation.id]);

    const accept = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: as(o, invitee),
        payload: { token },
      });
    expect((await accept(old.token)).json().error.code).toBe('ORGANIZATION_INVITATION_NOT_USABLE');
    expect((await accept(fresh.token)).json().data.membership.role).toBe('ADMIN');
  });

  it('refuses an invitation that was already revoked', async () => {
    const o = await orgApp(app, 'resend-revoked');
    const inv = await invite(app, o, o.owner, 'r@example.com');
    await app.inject({
      method: 'POST',
      url: `${listUrl(o.organizationId)}/${inv.invitation.id}/revoke`,
      headers: as(o, o.owner),
    });
    const res = await app.inject({
      method: 'POST',
      url: `${listUrl(o.organizationId)}/${inv.invitation.id}/resend`,
      headers: as(o, o.owner),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORGANIZATION_INVITATION_NOT_PENDING');
  });

  it("an ADMIN cannot resend an owner's invitation to the OWNER role", async () => {
    const o = await orgApp(app, 'resend-admin');
    const admin = await member(app, o, 'admin2@example.com', 'ADMIN');
    const inv = await invite(app, o, o.owner, 'future-owner@example.com', 'OWNER');
    const res = await app.inject({
      method: 'POST',
      url: `${listUrl(o.organizationId)}/${inv.invitation.id}/resend`,
      headers: as(o, admin),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');
  });
});
