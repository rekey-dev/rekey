/**
 * Sending an invitation again issues a new link, retires the old one, and
 * revives an expired invitation. An inviter who lost the link used to have to
 * revoke and re-invite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('resending a workspace invitation', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.99.0.1';
  const inject = (opts: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    app.inject({ remoteAddress: ip, ...opts } as never);
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function owner() {
    const t = `wir-${++n}-${Math.random().toString(36).slice(2, 7)}`;
    ip = `10.99.${n}.1`;
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `${t}@example.com`, password: 'pw-one-two-three', workspaceName: `${t} Co` },
    });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data as { accessToken: string; activeTenantId: string };
    return { t, token: data.accessToken, tenantId: data.activeTenantId };
  }

  async function invite(accessToken: string, email: string, role = 'MEMBER') {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(accessToken),
      payload: { email, role },
    });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data as { token: string; invitation: { id: string } };
    return { id: data.invitation.id, token: data.token };
  }

  const resend = (accessToken: string, id: string) =>
    inject({ method: 'POST', url: `/api/v1/tenant/workspace/invitations/${id}/resend`, headers: auth(accessToken) });
  const preview = (token: string) =>
    inject({ method: 'GET', url: `/api/v1/tenant/invitations/preview?token=${encodeURIComponent(token)}` });

  it('issues a new link and retires the old one', async () => {
    const o = await owner();
    const inv = await invite(o.token, `${o.t}-new@example.com`);

    const res = await resend(o.token, inv.id);
    expect(res.statusCode, res.body).toBe(200);
    const fresh = (res.json().data as { token: string }).token;
    expect(fresh).not.toBe(inv.token);
    expect((await preview(inv.token)).statusCode).toBe(404);
    expect((await preview(fresh)).statusCode).toBe(200);
  });

  it('revives an expired invitation with a new expiry', async () => {
    const o = await owner();
    const inv = await invite(o.token, `${o.t}-late@example.com`);
    await prisma.tenantInvitation.update({ where: { id: inv.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await resend(o.token, inv.id);
    expect(res.statusCode, res.body).toBe(200);
    const { token, expiresAt } = res.json().data as { token: string; expiresAt: string };
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await preview(token)).statusCode).toBe(200);
  });

  it('refuses a revoked invitation and one from another workspace', async () => {
    const o = await owner();
    const other = await owner();
    const inv = await invite(o.token, `${o.t}-gone@example.com`);
    await inject({ method: 'DELETE', url: `/api/v1/tenant/workspace/invitations/${inv.id}`, headers: auth(o.token) });

    const revoked = await resend(o.token, inv.id);
    expect([revoked.statusCode, revoked.json().error.code]).toEqual([400, 'INVITATION_NOT_USABLE']);
    const foreign = await resend(other.token, inv.id);
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([404, 'INVITATION_NOT_FOUND']);
  });

  it('an admin cannot resend an owner invitation', async () => {
    const o = await owner();
    const adminEmail = `${o.t}-admin@example.com`;
    const adminInvite = await invite(o.token, adminEmail, 'ADMIN');
    const signedUp = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: adminEmail, password: 'pw-one-two-three', inviteKey: adminInvite.token },
    });
    expect(signedUp.statusCode, signedUp.body).toBe(201);
    const adminToken = (signedUp.json().data as { accessToken: string }).accessToken;
    const ownerInvite = await invite(o.token, `${o.t}-owner2@example.com`, 'OWNER');

    const res = await resend(adminToken, ownerInvite.id);
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'TENANT_ROLE_INSUFFICIENT']);
  });

  it('refuses to resend to someone who joined through another invitation', async () => {
    const o = await owner();
    const email = `${o.t}-twice@example.com`;
    const first = await invite(o.token, email);
    const second = await invite(o.token, email);
    const joined = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', inviteKey: second.token },
    });
    expect(joined.statusCode, joined.body).toBe(201);

    const res = await resend(o.token, first.id);
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'INVITE_TARGET_ALREADY_MEMBER']);
  });
});
