/**
 * `rekey init --owner-email X` creates a workspace through the super-admin
 * routes, which write no membership: `ownerEmail` is a label. When X then
 * signed up they got a second, empty workspace and the CLI-made one stayed
 * unreachable. A super-admin can now mint an operator invite bound to that
 * workspace. Redeeming it joins the workspace at the bound role, at sign-up
 * for a new operator and through the invitation accept route for an existing
 * one, and only for the email it was minted for.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashOperatorInviteToken } from '../src/lib/operator-invite.js';
import { tenantAuthService } from '../src/modules/tenant-auth/tenant-auth.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('workspace-bound operator invites', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.97.0.1';
  const inject = (opts: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    app.inject({ remoteAddress: ip, ...opts } as never);
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

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
    ip = `10.97.${++n}.1`;
    return `wbi-${n}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /** What `rekey init` does: a bare workspace through the super-admin route. */
  async function adminTenant(ownerEmail: string): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: admin,
      payload: { name: 'Init Co', ownerEmail },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { id: string }).id;
  }

  async function mint(body: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return inject({ method: 'POST', url: '/api/v1/admin/operator-invites', headers: admin, payload: body });
  }

  async function boundInvite(tenantId: string, email: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await mint({ tenantId, email, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
  }

  const signUp = (email: string, body: Record<string, unknown> = {}) =>
    inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', ...body },
    });

  async function operator(email: string): Promise<string> {
    const res = await signUp(email, { workspaceName: 'Own Co' });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { accessToken: string }).accessToken;
  }

  const accept = (token: string, session: string) =>
    inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(session),
      payload: { token },
    });

  async function ownerOf(tenantId: string): Promise<string[]> {
    const rows = await prisma.tenantMembership.findMany({
      where: { tenantId, role: 'OWNER' },
      include: { tenantUser: { select: { email: true } } },
    });
    return rows.map((r) => r.tenantUser.email);
  }

  describe('minting', () => {
    it('binds a key to the workspace, defaults to OWNER, expires in 7 days, stores only the hash', async () => {
      const t = tag();
      const tenantId = await adminTenant(`owner-${t}@example.com`);
      const res = await mint({ tenantId, email: `Owner-${t}@Example.com` });
      expect(res.statusCode, res.body).toBe(201);
      const data = res.json().data as {
        rawToken: string;
        inviteUrl: string | null;
        invite: { tenantId: string; email: string; role: string; expiresAt: string };
      };
      expect(data.invite).toMatchObject({ tenantId, email: `owner-${t}@example.com`, role: 'OWNER' });
      const ttl = Date.parse(data.invite.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(7 * DAY_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(7 * DAY_MS);
      const row = await prisma.operatorInvite.findFirstOrThrow({ where: { tenantId } });
      expect(row.tokenHash).toBe(hashOperatorInviteToken(data.rawToken));
      expect(JSON.stringify(row)).not.toContain(data.rawToken);
    });

    it('refuses a binding that is incomplete or names no workspace', async () => {
      const t = tag();
      const tenantId = await adminTenant(`owner-${t}@example.com`);
      const noEmail = await mint({ tenantId });
      expect(noEmail.statusCode).toBe(400);
      expect(noEmail.json().error.code).toBe('OPERATOR_INVITE_EMAIL_REQUIRED');
      const noTenant = await mint({ email: `owner-${t}@example.com`, role: 'OWNER' });
      expect(noTenant.statusCode).toBe(400);
      expect(noTenant.json().error.code).toBe('OPERATOR_INVITE_TENANT_REQUIRED');
      const ghost = await mint({ tenantId: 'no-such-tenant', email: `owner-${t}@example.com` });
      expect(ghost.statusCode).toBe(404);
      expect(ghost.json().error.code).toBe('TENANT_NOT_FOUND');
      expect(await prisma.operatorInvite.count()).toBe(0);
    });

    it('only the super-admin can mint one', async () => {
      const t = tag();
      const tenantId = await adminTenant(`owner-${t}@example.com`);
      const session = await operator(`someone-${t}@example.com`);
      const res = await inject({
        method: 'POST',
        url: '/api/v1/admin/operator-invites',
        headers: auth(session),
        payload: { tenantId, email: `someone-${t}@example.com` },
      });
      expect(res.statusCode).toBe(401);
      expect(await prisma.operatorInvite.count()).toBe(0);
    });
  });

  describe('a new operator redeems it at sign-up', () => {
    for (const mode of ['open', 'invite'] as const) {
      it(`${mode} mode: joins the bound workspace as OWNER and creates no workspace of its own`, async () => {
        process.env.OPERATOR_SIGNUP_MODE = mode;
        const t = tag();
        const email = `owner-${t}@example.com`;
        const tenantId = await adminTenant(email);
        const key = await boundInvite(tenantId, email);
        const tenantsBefore = await prisma.tenant.count();

        const res = await signUp(email.toUpperCase(), { inviteKey: key });
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json().data).toMatchObject({ activeTenantId: tenantId, activeRole: 'OWNER' });
        expect(await prisma.tenant.count()).toBe(tenantsBefore);
        expect(await ownerOf(tenantId)).toEqual([email]);
        const row = await prisma.operatorInvite.findFirstOrThrow({ where: { tenantId } });
        expect(row.usedAt).not.toBeNull();
      });
    }

    it('grants the role the key was minted with', async () => {
      const t = tag();
      const email = `admin-${t}@example.com`;
      const tenantId = await adminTenant(`owner-${t}@example.com`);
      const key = await boundInvite(tenantId, email, { role: 'ADMIN' });
      const res = await signUp(email, { inviteKey: key });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().data.activeRole).toBe('ADMIN');
    });

    it('refuses a different email, creating nothing and leaving the key usable', async () => {
      process.env.OPERATOR_SIGNUP_MODE = 'invite';
      const t = tag();
      const email = `owner-${t}@example.com`;
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);

      const res = await signUp(`intruder-${t}@example.com`, { inviteKey: key, workspaceName: 'Mine' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('OPERATOR_INVITE_EMAIL_MISMATCH');
      expect(await prisma.tenantUser.count({ where: { email: `intruder-${t}@example.com` } })).toBe(0);
      expect((await prisma.operatorInvite.findFirstOrThrow({ where: { tenantId } })).usedAt).toBeNull();

      expect((await signUp(email, { inviteKey: key })).statusCode).toBe(201);
    });

    it('is single-use: a second sign-up with the same key is refused', async () => {
      const t = tag();
      const email = `owner-${t}@example.com`;
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);
      expect((await signUp(email, { inviteKey: key })).statusCode).toBe(201);
      await prisma.tenantUser.delete({ where: { email } });
      const again = await signUp(email, { inviteKey: key });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('OPERATOR_INVITE_USED');
    });

    it('refuses an expired key, even in open mode, instead of making a fresh workspace', async () => {
      const t = tag();
      const email = `owner-${t}@example.com`;
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);
      await prisma.operatorInvite.updateMany({ where: { tenantId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await signUp(email, { inviteKey: key, workspaceName: 'Fallback' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('OPERATOR_INVITE_EXPIRED');
      expect(await prisma.tenantUser.count({ where: { email } })).toBe(0);
    });

    it('closed mode still refuses to create the operator', async () => {
      process.env.OPERATOR_SIGNUP_MODE = 'closed';
      const t = tag();
      const email = `owner-${t}@example.com`;
      const key = await boundInvite(await adminTenant(email), email);
      const res = await signUp(email, { inviteKey: key });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('OPERATOR_SIGNUP_CLOSED');
    });

    it('OAuth first login with the key joins the workspace too', async () => {
      process.env.OPERATOR_SIGNUP_MODE = 'invite';
      const t = tag();
      const email = `oauth-${t}@example.com`;
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);
      const tenantsBefore = await prisma.tenant.count();
      await expect(
        tenantAuthService.findOrCreateOAuthOperator({ email: `x-${email}`, emailVerified: true, inviteKey: key }),
      ).rejects.toMatchObject({ code: 'OPERATOR_INVITE_EMAIL_MISMATCH' });
      const user = await tenantAuthService.findOrCreateOAuthOperator({ email, emailVerified: true, inviteKey: key });
      expect(await prisma.tenant.count()).toBe(tenantsBefore);
      const memberships = await prisma.tenantMembership.findMany({ where: { tenantUserId: user.id } });
      expect(memberships.map((m) => [m.tenantId, m.role])).toEqual([[tenantId, 'OWNER']]);
    });
  });

  describe('plain sign-up is unchanged', () => {
    it('without a workspace-bound key, sign-up still needs and creates its own workspace', async () => {
      const t = tag();
      const email = `plain-${t}@example.com`;
      const tenantId = await adminTenant(email);
      const noName = await signUp(email);
      expect(noName.statusCode).toBe(400);
      expect(noName.json().error.code).toBe('WORKSPACE_NAME_REQUIRED');
      const res = await signUp(email, { workspaceName: 'Plain Co' });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.activeTenantId).not.toBe(tenantId);
      expect(await ownerOf(tenantId)).toEqual([]);
    });

    it('invite mode with an unbound key still creates a new workspace', async () => {
      process.env.OPERATOR_SIGNUP_MODE = 'invite';
      const t = tag();
      const minted = await mint({});
      const key = (minted.json().data as { rawToken: string; inviteUrl: string | null }).rawToken;
      expect(minted.json().data.inviteUrl).toBeNull();
      const before = await prisma.tenant.count();
      const res = await signUp(`unbound-${t}@example.com`, { inviteKey: key, workspaceName: 'New Co' });
      expect(res.statusCode, res.body).toBe(201);
      expect(await prisma.tenant.count()).toBe(before + 1);
    });
  });

  describe('an existing operator redeems it through the invitation routes', () => {
    it('previews then accepts, joining as OWNER with a session in that workspace', async () => {
      const t = tag();
      const email = `existing-${t}@example.com`;
      const session = await operator(email);
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);

      const preview = await inject({
        method: 'GET',
        url: `/api/v1/tenant/invitations/preview?token=${encodeURIComponent(key)}`,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().data).toMatchObject({ tenantId, tenantName: 'Init Co', role: 'OWNER', invitedEmail: email });

      const res = await accept(key, session);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.membership).toMatchObject({ tenantId, role: 'OWNER' });
      expect(await ownerOf(tenantId)).toEqual([email]);

      const replay = await accept(key, session);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error.code).toBe('INVITATION_NOT_USABLE');
      const previewUsed = await inject({
        method: 'GET',
        url: `/api/v1/tenant/invitations/preview?token=${encodeURIComponent(key)}`,
      });
      expect(previewUsed.json().error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('refuses an operator with a different email and leaves the key unused', async () => {
      const t = tag();
      const email = `owner-${t}@example.com`;
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);
      const other = await operator(`other-${t}@example.com`);
      const res = await accept(key, other);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INVITATION_EMAIL_MISMATCH');
      expect(await ownerOf(tenantId)).toEqual([]);
      expect((await prisma.operatorInvite.findFirstOrThrow({ where: { tenantId } })).usedAt).toBeNull();
    });

    it('refuses an expired or revoked key', async () => {
      const t = tag();
      const email = `owner-${t}@example.com`;
      const session = await operator(email);
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);
      await prisma.operatorInvite.updateMany({ where: { tenantId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await accept(key, session);
      expect(expired.statusCode).toBe(400);
      expect(expired.json().error.code).toBe('INVITATION_EXPIRED');

      const revokedKey = await boundInvite(tenantId, email);
      const row = await prisma.operatorInvite.findFirstOrThrow({ where: { tokenHash: hashOperatorInviteToken(revokedKey) } });
      await inject({ method: 'DELETE', url: `/api/v1/admin/operator-invites/${row.id}`, headers: admin });
      expect((await accept(revokedKey, session)).json().error.code).toBe('INVITATION_NOT_USABLE');
      expect(await ownerOf(tenantId)).toEqual([]);
    });

    it('an unbound key is not an invitation to anything', async () => {
      const t = tag();
      const session = await operator(`existing-${t}@example.com`);
      const key = (await mint({})).json().data.rawToken as string;
      const preview = await inject({
        method: 'GET',
        url: `/api/v1/tenant/invitations/preview?token=${encodeURIComponent(key)}`,
      });
      expect(preview.statusCode).toBe(404);
      expect(preview.json().error.code).toBe('INVITATION_NOT_FOUND');
      expect((await accept(key, session)).json().error.code).toBe('INVITATION_NOT_USABLE');
    });

    it('8 concurrent accepts of one key join once and consume it once', async () => {
      const t = tag();
      const email = `race-${t}@example.com`;
      const session = await operator(email);
      const tenantId = await adminTenant(email);
      const key = await boundInvite(tenantId, email);
      const results = await Promise.all(Array.from({ length: 8 }, () => accept(key, session)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) {
        expect(r.json().error.code).toBe('INVITATION_NOT_USABLE');
      }
      expect(await prisma.tenantMembership.count({ where: { tenantId } })).toBe(1);
      const refreshTokens = await prisma.tenantRefreshToken.count({ where: { activeTenantId: tenantId } });
      expect(refreshTokens).toBe(1);
    });
  });
});
