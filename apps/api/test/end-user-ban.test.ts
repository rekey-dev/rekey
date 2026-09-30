/**
 * Operator ban of an end-user:
 *   GET/POST /tenant/applications/:id/end-users/:euid/ban, POST .../unban
 *
 * The door tests do not rely on the ban's revocations. Each one recreates the
 * state a request racing the ban could leave behind (a refresh row the revoke
 * missed, an access token newer than the stamp, a link minted after the ban)
 * and proves the ban check itself refuses it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { issueResetToken } from '../src/lib/password-reset.js';
import { issueMagicLinkToken } from '../src/lib/magic-link.js';
import { issueVerificationToken } from '../src/lib/email-verification.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';
import { issueMcpAccessToken } from '../src/lib/jwt.js';
import { mcpIssuer } from '../src/modules/mcp/oauth.service.js';

const PASSWORD = 'pw-one-two-three';
const REASON = 'Chargeback fraud, ticket 4412';

type Json = Record<string, unknown>;

describe('end-user ban', () => {
  let app: FastifyInstance;
  let operator: string;
  let operatorId: string;
  let appId: string;
  let appSlug: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (token = operator) => ({ authorization: `Bearer ${token}` });
  const sk = () => ({ authorization: `Bearer ${liveKey}` });
  const asUser = (accessToken: string) => ({ ...sk(), 'x-rekey-user-token': accessToken });
  const base = (euid: string) => `/api/v1/tenant/applications/${appId}/end-users/${euid}`;

  async function newWorkspace(slug: string): Promise<{ token: string; userId: string }> {
    const data = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-ban-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ban ${slug}` },
      })
      .then((r) => r.json().data as { accessToken: string; user: { id: string } });
    return { token: data.accessToken, userId: data.user.id };
  }

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    const ws = await newWorkspace(slug);
    operator = ws.token;
    operatorId = ws.userId;
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'Ban', slug: `ban-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    appSlug = `ban-${slug}`;
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: {
        authConfig: {
          ...(application.authConfig as Json),
          methods: ['password', 'magic_link'],
          // So every sign-in mail can build its link and a missing gate shows
          // up as a minted token rather than a skipped send.
          appUrl: 'https://app.example.com',
        },
      },
    });
  });

  async function signUp(email: string): Promise<{ euid: string; accessToken: string; refreshToken: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { endUser: { id: string }; accessToken: string; refreshToken: string };
    return { euid: data.endUser.id, accessToken: data.accessToken, refreshToken: data.refreshToken };
  }

  const signIn = (email: string, password = PASSWORD) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/sign-in', headers: sk(), payload: { email, password } });

  const ban = (euid: string, reason: unknown = REASON, token = operator) =>
    app.inject({ method: 'POST', url: `${base(euid)}/ban`, headers: op(token), payload: { reason } });

  const unban = (euid: string) => app.inject({ method: 'POST', url: `${base(euid)}/unban`, headers: op() });

  const me = (accessToken: string) =>
    app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-rekey-user-token': accessToken } });

  function expectBanned(res: { statusCode: number; json: () => Json }): void {
    expect(res.statusCode).toBe(403);
    expect((res.json().error as Json).code).toBe('END_USER_BANNED');
    expect(JSON.stringify(res.json())).not.toContain(REASON);
  }

  it('records reason and operator, ends every session, and refuses sign-in', async () => {
    const { euid, accessToken, refreshToken } = await signUp('a@example.com');
    await signIn('a@example.com');

    const res = await ban(euid);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { state: Json; alreadyBanned: boolean; sessionsRevoked: number };
    expect(data.alreadyBanned).toBe(false);
    expect(data.sessionsRevoked).toBe(2);
    expect(data.state).toMatchObject({
      banned: true,
      bannedBy: operatorId,
      bannedByEmail: expect.stringContaining('op-ban-'),
      banReason: REASON,
    });

    expectBanned(await signIn('a@example.com'));
    expectBanned(await me(accessToken));
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: sk(), payload: { refreshToken } });
    expect(refresh.statusCode).toBe(401);
    expect((refresh.json().error as Json).code).toBe('REFRESH_TOKEN_REVOKED');
    expect(await prisma.refreshToken.count({ where: { endUserId: euid, revokedAt: null } })).toBe(0);
  });

  it('answers a wrong password on a banned account exactly like any wrong password', async () => {
    const { euid } = await signUp('b@example.com');
    await ban(euid);
    const wrong = await signIn('b@example.com', 'not-the-password');
    expect(wrong.statusCode).toBe(401);
    expect((wrong.json().error as Json).code).toBe('INVALID_CREDENTIALS');
  });

  it('requires a reason, trims it, and strips control characters', async () => {
    const { euid } = await signUp('c@example.com');
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const r = await ban(euid, reason);
      expect(r.statusCode).toBe(400);
      expect((r.json().error as Json).code).toBe('BAN_REASON_INVALID');
    }
    const ok = await ban(euid, '  spam\u0007 bot  ');
    expect((ok.json().data as { state: Json }).state.banReason).toBe('spam bot');
  });

  it('a second ban keeps the original record; unban is idempotent and lets them back in', async () => {
    const { euid } = await signUp('d@example.com');
    const first = (await ban(euid)).json().data as { state: Json };
    const again = (await ban(euid, 'a different story')).json().data as { state: Json; alreadyBanned: boolean };
    expect(again.alreadyBanned).toBe(true);
    expect(again.state).toEqual(first.state);

    const lifted = await unban(euid);
    expect(lifted.statusCode).toBe(200);
    expect((lifted.json().data as Json).wasBanned).toBe(true);
    expect(((await unban(euid)).json().data as Json).wasBanned).toBe(false);
    expect((await signIn('d@example.com')).statusCode).toBe(200);

    const row = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect([row.bannedAt, row.bannedBy, row.banReason]).toEqual([null, null, null]);
  });

  it('keeps who banned and why in the history, written with the ban', async () => {
    const { euid } = await signUp('e@example.com');
    await ban(euid);
    await unban(euid);
    const history = await app.inject({ method: 'GET', url: `${base(euid)}/ban`, headers: op() });
    expect(history.statusCode).toBe(200);
    const data = history.json().data as { state: Json; history: Json[] };
    expect(data.state.banned).toBe(false);
    expect(data.history.map((h) => h.type)).toEqual(['end_user.unbanned', 'end_user.banned']);
    expect(data.history[1]).toMatchObject({ actorId: operatorId, reason: REASON });
    const events = await prisma.securityEvent.findMany({
      where: { subjectEndUserId: euid, type: 'end_user.banned' },
    });
    expect(events[0]?.metadata).toMatchObject({ via: 'session', reason: REASON });
  });

  it('is operator-only and workspace-scoped', async () => {
    const { euid } = await signUp('f@example.com');
    const other = await newWorkspace(`x${Math.random().toString(36).slice(2, 6)}`);
    expect((await ban(euid, REASON, other.token)).statusCode).toBe(404);
    const viaSecretKey = await app.inject({
      method: 'POST',
      url: `${base(euid)}/ban`,
      headers: sk(),
      payload: { reason: REASON },
    });
    expect(viaSecretKey.statusCode).toBe(401);
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: euid } })).bannedAt).toBeNull();
  });

  it('refuses an erased user with 410 and erasure scrubs the reason from row and history', async () => {
    const { euid } = await signUp('g@example.com');
    await ban(euid);
    const erased = await app.inject({ method: 'DELETE', url: `${base(euid)}?erasure=true`, headers: op() });
    expect(erased.statusCode).toBe(200);
    const row = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect(row.banReason).toBeNull();
    expect(row.bannedAt).not.toBeNull();
    const events = await prisma.securityEvent.findMany({ where: { subjectEndUserId: euid, type: 'end_user.banned' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).not.toHaveProperty('reason');
    expect((await unban(euid)).statusCode).toBe(410);
    expect((await ban(euid)).statusCode).toBe(410);
  });

  it('a ban keeps a pending email change in reach of the export and a later erasure', async () => {
    const { euid } = await signUp('g2@example.com');
    const pending = 'g2-new@example.com';
    await issueVerificationToken({ applicationId: appId, endUserId: euid, email: pending });
    await issueMagicLinkToken({ applicationId: appId, endUserId: euid, email: pending });
    const { tenantId } = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.contact.create({ data: { applicationId: appId, email: pending } });
    await prisma.emailSuppression.create({ data: { applicationId: appId, address: pending, reason: 'bounce' } });
    await prisma.emailLog.create({
      data: { tenantId, applicationId: appId, toAddress: pending, subject: 'Confirm', eventKey: 'verify', via: 'byo_resend', status: 'sent' },
    });
    await ban(euid);

    const now = new Date();
    const live = { endUserId: euid, consumedAt: null, expiresAt: { gt: now } };
    expect(await prisma.emailVerificationToken.count({ where: live })).toBe(0);
    expect(await prisma.magicLinkToken.count({ where: live })).toBe(0);

    const exported = await app.inject({ method: 'GET', url: `${base(euid)}/export`, headers: op() });
    expect(exported.statusCode).toBe(200);
    expect((exported.json() as { contacts: Array<{ email: string }> }).contacts.map((c) => c.email)).toContain(pending);

    const erased = await app.inject({ method: 'DELETE', url: `${base(euid)}?erasure=true`, headers: op() });
    expect(erased.statusCode).toBe(200);
    expect(await prisma.contact.count({ where: { applicationId: appId, email: pending } })).toBe(0);
    expect(await prisma.emailSuppression.count({ where: { applicationId: appId, address: pending } })).toBe(0);
    expect(await prisma.emailLog.count({ where: { applicationId: appId, toAddress: pending } })).toBe(0);
  });

  it('keeps the ban reason out of the DSAR export and reports when the ban was placed', async () => {
    const { euid } = await signUp('g3@example.com');
    await ban(euid);
    const res = await app.inject({ method: 'GET', url: `${base(euid)}/export`, headers: op() });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(REASON);
    const doc = res.json() as { endUser: Json; securityEvents: Array<{ type: string; metadata: Json }> };
    expect(doc.endUser.bannedAt).toEqual(expect.any(String));
    expect(doc.endUser).not.toHaveProperty('banReason');
    expect(doc.endUser).not.toHaveProperty('bannedBy');
    const banned = doc.securityEvents.find((e) => e.type === 'end_user.banned');
    expect(banned?.metadata).toMatchObject({ endUserId: euid });
    expect(banned?.metadata).not.toHaveProperty('reason');
    const operatorSide = await app.inject({ method: 'GET', url: `${base(euid)}/ban`, headers: op() });
    expect(JSON.stringify(operatorSide.json())).toContain(REASON);
  });

  it('keeps ban details out of end-user and secret-key payloads', async () => {
    const { euid } = await signUp('h@example.com');
    await ban(euid);
    const viaKey = await app.inject({ method: 'GET', url: `/api/v1/users/${euid}`, headers: sk() });
    expect(viaKey.statusCode).toBe(200);
    const body = viaKey.json().data as Json;
    expect(body.bannedAt).toEqual(expect.any(String));
    expect(body).not.toHaveProperty('banReason');
    expect(body).not.toHaveProperty('bannedBy');
  });

  it('announces user.banned and user.unbanned without the reason', async () => {
    await prisma.webhookEndpoint.create({
      data: {
        applicationId: appId,
        url: 'https://example.com/hook',
        secret: 'whsec_test_ban',
        events: ['user.banned', 'user.unbanned'],
        enabled: true,
      },
    });
    const { euid } = await signUp('i@example.com');
    await ban(euid);
    await unban(euid);
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: { in: ['user.banned', 'user.unbanned'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.eventType)).toEqual(['user.banned', 'user.unbanned']);
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toContain(REASON);
    expect((rows[0]?.payload as { data: Json }).data).toMatchObject({ user: { id: euid }, sessionsRevoked: 1 });
  });

  it('lists banned end-users with ?banned=true', async () => {
    const a = await signUp('j1@example.com');
    await signUp('j2@example.com');
    await ban(a.euid);
    const banned = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/end-users?banned=true`, headers: op() });
    expect((banned.json().data as { items: Json[] }).items.map((u) => u.id)).toEqual([a.euid]);
    const rest = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/end-users?banned=false`, headers: op() });
    expect((rest.json().data as { items: Json[] }).items.map((u) => u.email)).toEqual(['j2@example.com']);
  });

  it('counts an erased end-user as not banned in the list', async () => {
    const a = await signUp('k1@example.com');
    const b = await signUp('k2@example.com');
    await ban(a.euid);
    await ban(b.euid);
    expect((await app.inject({ method: 'DELETE', url: `${base(b.euid)}?erasure=true`, headers: op() })).statusCode).toBe(200);
    const list = (banned: string) =>
      app
        .inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/end-users?banned=${banned}`, headers: op() })
        .then((r) => (r.json().data as { items: Json[] }).items);
    expect((await list('true')).map((u) => u.id)).toEqual([a.euid]);
    const rest = await list('false');
    expect(rest.map((u) => u.id)).toEqual([b.euid]);
    expect(rest[0]?.bannedAt).toBeNull();
  });

  describe('every door checks the ban itself, not only the revocations', () => {
    it('refresh: a refresh row the revoke missed', async () => {
      const { euid, refreshToken } = await signUp('k@example.com');
      await ban(euid);
      await prisma.refreshToken.updateMany({ where: { endUserId: euid }, data: { revokedAt: null } });
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: sk(), payload: { refreshToken } });
      expectBanned(res);
    });

    it('session chokepoint: an access token newer than the stamp', async () => {
      const { euid, accessToken } = await signUp('l@example.com');
      await ban(euid);
      await prisma.endUser.update({ where: { id: euid }, data: { sessionsInvalidBefore: null } });
      await prisma.refreshToken.updateMany({ where: { endUserId: euid }, data: { revokedAt: null } });
      expectBanned(await me(accessToken));
      const self = await app.inject({ method: 'GET', url: '/api/v1/users/me/', headers: asUser(accessToken) });
      expectBanned(self);
    });

    it('password reset: requests send nothing, a link minted after the ban is refused unspent', async () => {
      const { euid } = await signUp('m@example.com');
      await ban(euid);
      const request = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: sk(),
        payload: { email: 'm@example.com' },
      });
      expect(request.statusCode).toBe(200);
      expect(request.json().data).toMatchObject({ delivered: false, resetToken: null });
      expect(await prisma.passwordResetToken.count({ where: { endUserId: euid } })).toBe(0);

      const { raw } = await issueResetToken(appId, euid);
      const reset = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        headers: sk(),
        payload: { token: raw, newPassword: 'a-brand-new-password' },
      });
      expectBanned(reset);
      expect(await prisma.passwordResetToken.count({ where: { endUserId: euid, consumedAt: null } })).toBe(1);
    });

    it('magic link: requests mint nothing, a link minted after the ban is refused before it is spent', async () => {
      const { euid } = await signUp('n@example.com');
      await ban(euid);
      const request = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: sk(),
        payload: { email: 'n@example.com' },
      });
      expect(request.statusCode).toBe(200);
      expect(request.json().data).toMatchObject({ delivered: false, magicLinkToken: null });
      expect(await prisma.magicLinkToken.count({ where: { endUserId: euid, consumedAt: null, expiresAt: { gt: new Date() } } })).toBe(0);

      const { raw } = await issueMagicLinkToken({ applicationId: appId, endUserId: euid, email: 'n@example.com' });
      const verify = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: sk(),
        payload: { token: raw },
      });
      expectBanned(verify);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
      expect(user.emailVerified).toBe(false);
      expect(await prisma.magicLinkToken.count({ where: { endUserId: euid, consumedAt: null } })).toBe(1);
    });

    it('email verification: resends send nothing, a link minted after the ban is refused unspent', async () => {
      const { euid } = await signUp('ev@example.com');
      await ban(euid);
      const resend = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
        headers: sk(),
        payload: { email: 'ev@example.com' },
      });
      expect(resend.statusCode).toBeLessThan(300);
      expect(
        await prisma.emailVerificationToken.count({ where: { endUserId: euid, consumedAt: null, expiresAt: { gt: new Date() } } }),
      ).toBe(0);

      const { raw } = await issueVerificationToken({ applicationId: appId, endUserId: euid, email: 'ev@example.com' });
      const verify = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/verify-email',
        headers: sk(),
        payload: { token: raw },
      });
      expectBanned(verify);
      expect((await prisma.endUser.findUniqueOrThrow({ where: { id: euid } })).emailVerified).toBe(false);
    });

    it('MFA: a challenge issued before the ban cannot be completed', async () => {
      const { euid, accessToken } = await signUp('o@example.com');
      const setup = (await app
        .inject({ method: 'POST', url: '/api/v1/auth/mfa/setup', headers: asUser(accessToken) })
        .then((r) => r.json().data)) as { otpauthUrl: string; backupCodes: string[] };
      const secret = new URL(setup.otpauthUrl.replace('otpauth://', 'https://x/')).searchParams.get('secret')!;
      const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
      await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/setup-confirm', headers: asUser(accessToken), payload: { code } });
      const challenge = (await signIn('o@example.com')).json().data as { mfaRequired: boolean; mfaChallengeToken: string };
      expect(challenge.mfaRequired).toBe(true);

      await ban(euid);
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa-verify',
        headers: sk(),
        payload: { mfaChallengeToken: challenge.mfaChallengeToken, code: setup.backupCodes[0] },
      });
      expectBanned(verified);

      // Refused before the code was matched: after the ban is lifted the same
      // challenge and backup code still work.
      await unban(euid);
      const retried = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa-verify',
        headers: sk(),
        payload: { mfaChallengeToken: challenge.mfaChallengeToken, code: setup.backupCodes[0] },
      });
      expect(retried.statusCode).toBe(200);
    });

    it('OIDC/MCP: a grant token newer than the stamp is invalid', async () => {
      const { euid } = await signUp('oidc@example.com');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/auth-config`,
        headers: op(),
        payload: { mcpEnabled: true, oidcEnabled: true },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      const mint = () =>
        issueMcpAccessToken({
          endUserId: euid,
          applicationId: appId,
          tokenGeneration: application.tokenGeneration,
          audience: mcpIssuer(appSlug),
          scope: 'openid mcp:account',
        }).token;
      const userinfo = (token: string) =>
        app.inject({
          method: 'GET',
          url: `/api/v1/mcp/${appSlug}/oauth/userinfo`,
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await userinfo(mint())).statusCode).toBe(200);

      await ban(euid);
      await prisma.endUser.update({ where: { id: euid }, data: { sessionsInvalidBefore: null } });
      const refused = await userinfo(mint());
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toMatchObject({ error: 'invalid_token' });
    });

    it('licence verify: a banned holder is suspended', async () => {
      const { euid } = await signUp('p@example.com');
      const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
      const { rawKey } = await licensesService.issue({ application, endUser, kind: 'SEATS', seatsAllowed: 2 });
      await ban(euid);
      const verify = await app.inject({
        method: 'POST',
        url: '/api/v1/licenses/verify',
        headers: sk(),
        payload: { key: rawKey, machineFingerprint: 'fp-banned-0001' },
      });
      expect(verify.json().data).toMatchObject({ ok: false, reason: 'suspended' });
      await unban(euid);
      const again = await app.inject({
        method: 'POST',
        url: '/api/v1/licenses/verify',
        headers: sk(),
        payload: { key: rawKey, machineFingerprint: 'fp-banned-0001' },
      });
      expect(again.json().data).toMatchObject({ ok: true });
    });

    it('operator impersonation and sign-in mail are refused until the ban is lifted', async () => {
      const { euid } = await signUp('q@example.com');
      await ban(euid);
      const imp = await app.inject({ method: 'POST', url: `${base(euid)}/impersonate`, headers: op(), payload: {} });
      expectBanned(imp);
      expect(await prisma.impersonationAudit.count({ where: { endUserId: euid } })).toBe(0);
      const reset = await app.inject({
        method: 'POST',
        url: `${base(euid)}/send-password-reset`,
        headers: op(),
        payload: { reason: 'support ticket' },
      });
      expect((reset.json().error as Json).code).toBe('END_USER_BANNED');
    });
  });

  it('racing sign-ins and refreshes: every session minted around the ban is refused on use', async () => {
    const { euid } = await signUp('race@example.com');
    const sessions = await Promise.all(
      Array.from({ length: 8 }, () => signIn('race@example.com').then((r) => r.json().data as { refreshToken: string })),
    );
    const racers = [
      ...sessions.map((s) =>
        app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: sk(), payload: { refreshToken: s.refreshToken } }),
      ),
      ...Array.from({ length: 8 }, () => signIn('race@example.com')),
    ];
    const [banRes, ...results] = await Promise.all([ban(euid), ...racers]);
    expect(banRes.statusCode).toBe(200);
    const minted = results
      .filter((r) => r.statusCode === 200)
      .map((r) => r.json().data as { accessToken: string; refreshToken: string });
    for (const s of minted) {
      expectBanned(await me(s.accessToken));
      const refreshed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: sk(),
        payload: { refreshToken: s.refreshToken },
      });
      expect(refreshed.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});
