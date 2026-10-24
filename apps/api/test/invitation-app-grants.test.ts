/**
 * The apps an inviter picks for a MEMBER ride on the invitation and become
 * ApplicationGrant rows in the transaction that creates the membership, on
 * both ways in: accepting while signed in, and signing up with the link.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('app access chosen on an invitation', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.97.0.1';
  const inject = (opts: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    app.inject({ remoteAddress: ip, ...opts } as never);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const signUp = async (email: string, body: Record<string, unknown> = {}) =>
    inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', ...body },
    });

  /** An owner with two apps, and the address they will invite. */
  async function workspace() {
    ip = `10.97.${++n}.1`;
    const t = `iag-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const owner = await signUp(`${t}-owner@example.com`, { workspaceName: `${t} Co` });
    expect(owner.statusCode, owner.body).toBe(201);
    const { accessToken } = owner.json().data as { accessToken: string };
    const mkApp = async (suffix: string): Promise<string> => {
      const r = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: auth(accessToken),
        payload: { name: `App ${suffix}`, slug: `${t}-${suffix}` },
      });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json().data as { id: string }).id;
    };
    return { t, ownerToken: accessToken, appA: await mkApp('a'), appB: await mkApp('b'), inviteeEmail: `${t}-invitee@example.com` };
  }

  const invite = (ownerToken: string, payload: Record<string, unknown>) =>
    inject({ method: 'POST', url: '/api/v1/tenant/workspace/invitations', headers: auth(ownerToken), payload });

  async function grantsOf(email: string) {
    const m = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantUser: { email }, role: 'MEMBER' },
      include: { applicationGrants: { select: { applicationId: true, role: true } } },
    });
    return m.applicationGrants.map((g) => [g.applicationId, g.role]).sort();
  }

  it('signing up with the link creates the member with the chosen apps', async () => {
    const ws = await workspace();
    const res = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [{ applicationId: ws.appA, role: 'APP_BILLING' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const { token, invitation } = res.json().data as { token: string; invitation: { id: string; appGrants: unknown } };
    expect(invitation.appGrants).toEqual([{ applicationId: ws.appA, role: 'APP_BILLING' }]);

    const joined = await signUp(ws.inviteeEmail, { inviteKey: token });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(await grantsOf(ws.inviteeEmail)).toEqual([[ws.appA, 'APP_BILLING']]);
    const logged = await prisma.securityEvent.findMany({
      where: { type: 'member.app_grant_set', applicationId: ws.appA },
    });
    expect(logged.map((e) => [e.actorType, e.metadata])).toEqual([
      ['operator', expect.objectContaining({ role: 'APP_BILLING', invitationId: invitation.id })],
    ]);

    const memberToken = (joined.json().data as { accessToken: string }).accessToken;
    const list = await inject({ method: 'GET', url: '/api/v1/tenant/applications', headers: auth(memberToken) });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().data.items as { id: string }[]).map((a) => a.id)).toEqual([ws.appA]);
  });

  it('accepting while signed in creates the member with the chosen apps', async () => {
    const ws = await workspace();
    const res = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [
        { applicationId: ws.appA, role: 'APP_VIEWER' },
        { applicationId: ws.appB, role: 'APP_ADMIN' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const invitee = await signUp(ws.inviteeEmail, { workspaceName: `${ws.t} Own Co` });
    expect(invitee.statusCode, invitee.body).toBe(201);

    const accepted = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth((invitee.json().data as { accessToken: string }).accessToken),
      payload: { token: (res.json().data as { token: string }).token },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await grantsOf(ws.inviteeEmail)).toEqual(
      [
        [ws.appA, 'APP_VIEWER'],
        [ws.appB, 'APP_ADMIN'],
      ].sort(),
    );
  });

  it('refuses app grants on an admin invitation and apps from another workspace', async () => {
    const ws = await workspace();
    const other = await workspace();
    const onAdmin = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'ADMIN',
      appGrants: [{ applicationId: ws.appA, role: 'APP_VIEWER' }],
    });
    expect([onAdmin.statusCode, onAdmin.json().error.code]).toEqual([400, 'APP_GRANT_MEMBER_ONLY']);
    const foreign = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [{ applicationId: other.appA, role: 'APP_VIEWER' }],
    });
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([404, 'APPLICATION_NOT_FOUND']);
    expect(await prisma.tenantInvitation.count({ where: { email: ws.inviteeEmail } })).toBe(0);
  });

  it('refuses the same app twice in one invitation', async () => {
    const ws = await workspace();
    const res = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [
        { applicationId: ws.appA, role: 'APP_VIEWER' },
        { applicationId: ws.appA, role: 'APP_ADMIN' },
      ],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(await prisma.tenantInvitation.count({ where: { email: ws.inviteeEmail } })).toBe(0);
  });

  it('an admin can invite a member with apps', async () => {
    const ws = await workspace();
    const adminEmail = `${ws.t}-admin@example.com`;
    const adminInvite = await invite(ws.ownerToken, { email: adminEmail, role: 'ADMIN' });
    const admin = await signUp(adminEmail, { inviteKey: (adminInvite.json().data as { token: string }).token });
    expect(admin.statusCode, admin.body).toBe(201);
    const adminToken = (admin.json().data as { accessToken: string }).accessToken;

    const res = await invite(adminToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [{ applicationId: ws.appB, role: 'APP_VIEWER' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const joined = await signUp(ws.inviteeEmail, { inviteKey: (res.json().data as { token: string }).token });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(await grantsOf(ws.inviteeEmail)).toEqual([[ws.appB, 'APP_VIEWER']]);
  });

  it('an app deleted while the invitation waits drops out, and the rest still apply', async () => {
    const ws = await workspace();
    const res = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [
        { applicationId: ws.appA, role: 'APP_VIEWER' },
        { applicationId: ws.appB, role: 'APP_BILLING' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    await prisma.application.delete({ where: { id: ws.appA } });

    const joined = await signUp(ws.inviteeEmail, { inviteKey: (res.json().data as { token: string }).token });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(await grantsOf(ws.inviteeEmail)).toEqual([[ws.appB, 'APP_BILLING']]);
  });

  it('accepting after joining another way still adds the chosen apps', async () => {
    const ws = await workspace();
    const res = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [{ applicationId: ws.appA, role: 'APP_VIEWER' }],
    });
    const invitee = await signUp(ws.inviteeEmail, { workspaceName: `${ws.t} Own Co` });
    expect(invitee.statusCode, invitee.body).toBe(201);
    const tenantId = (await prisma.application.findUniqueOrThrow({ where: { id: ws.appA } })).tenantId;
    const userId = (await prisma.tenantUser.findUniqueOrThrow({ where: { email: ws.inviteeEmail } })).id;
    await prisma.tenantMembership.create({ data: { tenantUserId: userId, tenantId, role: 'MEMBER' } });

    const accepted = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth((invitee.json().data as { accessToken: string }).accessToken),
      payload: { token: (res.json().data as { token: string }).token },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await grantsOf(ws.inviteeEmail)).toEqual([[ws.appA, 'APP_VIEWER']]);
  });

  it('an existing member keeps a stronger grant, and the log records only what was added', async () => {
    const ws = await workspace();
    const res = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [
        { applicationId: ws.appA, role: 'APP_VIEWER' },
        { applicationId: ws.appB, role: 'APP_VIEWER' },
      ],
    });
    const invitee = await signUp(ws.inviteeEmail, { workspaceName: `${ws.t} Own Co` });
    const tenantId = (await prisma.application.findUniqueOrThrow({ where: { id: ws.appA } })).tenantId;
    const userId = (await prisma.tenantUser.findUniqueOrThrow({ where: { email: ws.inviteeEmail } })).id;
    await prisma.tenantMembership.create({
      data: {
        tenantUserId: userId,
        tenantId,
        role: 'MEMBER',
        applicationGrants: { create: { applicationId: ws.appA, role: 'APP_ADMIN' } },
      },
    });

    const accepted = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth((invitee.json().data as { accessToken: string }).accessToken),
      payload: { token: (res.json().data as { token: string }).token },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await grantsOf(ws.inviteeEmail)).toEqual(
      [
        [ws.appA, 'APP_ADMIN'],
        [ws.appB, 'APP_VIEWER'],
      ].sort(),
    );
    const logged = await prisma.securityEvent.findMany({ where: { type: 'member.app_grant_set', tenantId } });
    expect(logged.map((e) => e.applicationId)).toEqual([ws.appB]);
  });

  it('an admin who replaces the apps on resend is logged as granting them', async () => {
    const ws = await workspace();
    const adminEmail = `${ws.t}-admin@example.com`;
    const adminInvite = await invite(ws.ownerToken, { email: adminEmail, role: 'ADMIN' });
    const admin = await signUp(adminEmail, { inviteKey: (adminInvite.json().data as { token: string }).token });
    expect(admin.statusCode, admin.body).toBe(201);
    const adminId = (await prisma.tenantUser.findUniqueOrThrow({ where: { email: adminEmail } })).id;

    const res = await invite(ws.ownerToken, { email: ws.inviteeEmail, role: 'MEMBER' });
    const id = (res.json().data as { invitation: { id: string } }).invitation.id;
    const resent = await inject({
      method: 'POST',
      url: `/api/v1/tenant/workspace/invitations/${id}/resend`,
      headers: auth((admin.json().data as { accessToken: string }).accessToken),
      payload: { appGrants: [{ applicationId: ws.appA, role: 'APP_ADMIN' }] },
    });
    expect(resent.statusCode, resent.body).toBe(200);
    const joined = await signUp(ws.inviteeEmail, { inviteKey: resent.json().data.token });
    expect(joined.statusCode, joined.body).toBe(201);

    const logged = await prisma.securityEvent.findMany({
      where: { type: 'member.app_grant_set', applicationId: ws.appA },
    });
    expect(logged.map((e) => e.actorId)).toEqual([adminId]);
  });

  it('resend replaces the apps when given new ones, validated the same way', async () => {
    const ws = await workspace();
    const other = await workspace();
    const res = await invite(ws.ownerToken, {
      email: ws.inviteeEmail,
      role: 'MEMBER',
      appGrants: [{ applicationId: ws.appA, role: 'APP_VIEWER' }],
    });
    const id = (res.json().data as { invitation: { id: string } }).invitation.id;
    const resend = (payload?: Record<string, unknown>) =>
      inject({
        method: 'POST',
        url: `/api/v1/tenant/workspace/invitations/${id}/resend`,
        headers: auth(ws.ownerToken),
        ...(payload && { payload }),
      });

    const refused = await resend({ appGrants: [{ applicationId: other.appA, role: 'APP_VIEWER' }] });
    expect([refused.statusCode, refused.json().error.code]).toEqual([404, 'APPLICATION_NOT_FOUND']);

    const kept = await resend();
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().data.appGrants).toEqual([{ applicationId: ws.appA, role: 'APP_VIEWER' }]);

    const replaced = await resend({ appGrants: [{ applicationId: ws.appB, role: 'APP_ADMIN' }] });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const joined = await signUp(ws.inviteeEmail, { inviteKey: replaced.json().data.token });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(await grantsOf(ws.inviteeEmail)).toEqual([[ws.appB, 'APP_ADMIN']]);
  });
});
