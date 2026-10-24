/**
 * A person a workspace owner invites, who has no operator account yet, signs
 * up with the invitation link itself. Under OPERATOR_SIGNUP_MODE=invite they
 * used to be refused (the link was not an operator invite key), and under open
 * mode they got a second, empty workspace of their own.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('signing up from a workspace invitation link', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.98.0.1';
  const inject = (opts: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    app.inject({ remoteAddress: ip, ...opts } as never);

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    delete process.env.OPERATOR_SIGNUP_MODE;
  });

  function tag(): string {
    ip = `10.98.${++n}.1`;
    return `wis-${n}-${Math.random().toString(36).slice(2, 7)}`;
  }

  const signUp = (email: string, body: Record<string, unknown> = {}) =>
    inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', ...body },
    });

  /** An owner (created while sign-up is open) who invites `inviteeEmail`. */
  async function invitation(t: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
    const owner = await signUp(`${t}-owner@example.com`, { workspaceName: `${t} Co` });
    expect(owner.statusCode, owner.body).toBe(201);
    const { accessToken, activeTenantId } = owner.json().data as { accessToken: string; activeTenantId: string };
    const inviteeEmail = `${t}-invitee@example.com`;
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email: inviteeEmail, role },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { tenantId: activeTenantId, token: (res.json().data as { token: string }).token, inviteeEmail };
  }

  async function membershipsOf(email: string) {
    return prisma.tenantMembership.findMany({ where: { tenantUser: { email } } });
  }

  it('invite mode: the invitation link admits the invitee into the inviting workspace', async () => {
    const t = tag();
    const inv = await invitation(t, 'ADMIN');
    process.env.OPERATOR_SIGNUP_MODE = 'invite';

    const res = await signUp(inv.inviteeEmail, { inviteKey: inv.token });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().data as { activeTenantId: string }).activeTenantId).toBe(inv.tenantId);

    const memberships = await membershipsOf(inv.inviteeEmail);
    expect(memberships.map((m) => [m.tenantId, m.role])).toEqual([[inv.tenantId, 'ADMIN']]);
    const row = await prisma.tenantInvitation.findFirstOrThrow({ where: { tenantId: inv.tenantId } });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedById).toBe(memberships[0]!.tenantUserId);
  });

  it('open mode: the invitee joins instead of getting a second, empty workspace', async () => {
    const t = tag();
    const inv = await invitation(t);

    const res = await signUp(inv.inviteeEmail, { inviteKey: inv.token, workspaceName: 'Ignored Co' });
    expect(res.statusCode, res.body).toBe(201);
    const memberships = await membershipsOf(inv.inviteeEmail);
    expect(memberships.map((m) => m.tenantId)).toEqual([inv.tenantId]);
  });

  it('refuses a different email, and leaves the invitation usable', async () => {
    const t = tag();
    const inv = await invitation(t);
    process.env.OPERATOR_SIGNUP_MODE = 'invite';

    const res = await signUp(`${t}-someone-else@example.com`, { inviteKey: inv.token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OPERATOR_INVITE_EMAIL_MISMATCH');

    const ok = await signUp(inv.inviteeEmail, { inviteKey: inv.token });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('refuses a revoked, an expired and an already accepted invitation', async () => {
    const revoked = await invitation(tag());
    await prisma.tenantInvitation.updateMany({ where: { tenantId: revoked.tenantId }, data: { revokedAt: new Date() } });
    const expired = await invitation(tag());
    await prisma.tenantInvitation.updateMany({
      where: { tenantId: expired.tenantId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const accepted = await invitation(tag());
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    expect((await signUp(accepted.inviteeEmail, { inviteKey: accepted.token })).statusCode).toBe(201);

    const codes = await Promise.all(
      [revoked, expired].map((inv) =>
        signUp(inv.inviteeEmail, { inviteKey: inv.token }).then((r) => [r.statusCode, r.json().error.code]),
      ),
    );
    expect(codes).toEqual([
      [403, 'OPERATOR_INVITE_INVALID'],
      [403, 'OPERATOR_INVITE_EXPIRED'],
    ]);
    const replay = await signUp(`${tag()}-x@example.com`, { inviteKey: accepted.token });
    expect([replay.statusCode, replay.json().error.code]).toEqual([409, 'OPERATOR_INVITE_USED']);
  });

  it('closed mode still creates no operators, invitation or not', async () => {
    const inv = await invitation(tag());
    process.env.OPERATOR_SIGNUP_MODE = 'closed';
    const res = await signUp(inv.inviteeEmail, { inviteKey: inv.token });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'OPERATOR_SIGNUP_CLOSED']);
  });
});
