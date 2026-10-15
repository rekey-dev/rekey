/**
 * An operator confirms their address with a link, and until they do they may
 * not create anything that outlives their session.
 *
 * Operator sign-up needs no proof of the address. Someone who registers
 * another person's address gets a workspace, and could fill it with ways back
 * in that a later claim of the account never touches: a second owner they
 * invited, an Application secret key, a webhook pointed at their own server,
 * billing credentials. Those wait for a confirmed address. The confirmation
 * link itself ratifies the sign-up and removes nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { RekeyError } from '../src/lib/error.js';
import { sessionBasis } from '../src/lib/session-basis.js';
import { emailService } from '../src/modules/email/email.service.js';
import { operatorConfirmation } from '../src/modules/tenant-auth/operator-claim.js';
import { operatorMcpOAuthService } from '../src/modules/tenant-mcp/oauth.service.js';

const PASSWORD = 'operator-pw-one-two-three';

interface Session {
  accessToken: string;
  refreshToken: string;
  activeTenantId: string;
  user: { id: string; email: string; emailVerified: boolean };
}

describe('Operator email confirmation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    accessToken?: string,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url: `/api/v1/tenant${url}`,
      ...(accessToken && { headers: { authorization: `Bearer ${accessToken}` } }),
      ...(payload !== undefined && { payload: payload as never }),
    });

  async function signUp(tag = 'op'): Promise<Session> {
    const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const res = await call('POST', '/auth/sign-up', { email, password: PASSWORD, workspaceName: `WS ${tag}` });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data as Session;
  }

  async function confirmationToken(session: Session): Promise<string> {
    const res = await call('POST', '/auth/resend-verification', {}, session.accessToken);
    expect(res.statusCode, res.body).toBe(200);
    const token = (res.json().data as { verificationToken: string | null }).verificationToken;
    expect(token).toBeTruthy();
    return token!;
  }

  async function confirm(session: Session): Promise<void> {
    const res = await call('POST', '/auth/verify-email', { token: await confirmationToken(session) }, session.accessToken);
    expect(res.statusCode, res.body).toBe(200);
  }

  const me = (session: Session): Promise<LightMyRequestResponse> => call('GET', '/auth/me', undefined, session.accessToken);

  describe('the confirmation link', () => {
    it('sign-up mails one, pointing at the panel, with the same warning as the end-user verification mail', async () => {
      const dispatch = vi.spyOn(emailService, 'dispatchSystem');
      const session = await signUp();
      const sent = dispatch.mock.calls.map((c) => c[0]).filter((m) => m.to === session.user.email);
      expect(sent.map((m) => m.eventKey)).toEqual(['operator_email_verification']);
      const { defaultTemplate } = await import('../src/modules/email/defaults/index.js');
      const { SYSTEM_BRAND } = await import('../src/modules/email/defaults/brand.js');
      const text = defaultTemplate('operator_email_verification', SYSTEM_BRAND).text;
      expect(text).toContain('Only confirm if you created this account yourself.');
      expect(text).toContain('sign in');
      expect(text).toContain('Email me a sign-in link');
      expect(String(sent[0]!.variables.verifyUrl)).toMatch(/^https:\/\/panel\.test\.local\/verify-email\?token=[\w-]+$/);
    });

    it('confirms the address and changes nothing else: password, session, access tokens and MCP grants stay', async () => {
      const session = await signUp();
      // What an operator from before this release holds: tokens minted while unconfirmed.
      const token = await prisma.tenantApiToken.create({
        data: { tenantUserId: session.user.id, tenantId: session.activeTenantId, name: 'ci', tokenHash: 'h'.repeat(64), tokenPrefix: 'rp_op_x', scopes: [] },
      });
      const row = await prisma.tenantUser.findUniqueOrThrow({ where: { id: session.user.id } });
      await operatorMcpOAuthService.issueTokens({
        tenantUserId: session.user.id,
        tenantId: session.activeTenantId,
        clientId: 'client-1',
        scope: 'mcp:operator:read',
        grant: { basis: sessionBasis(row, () => new RekeyError({ statusCode: 400, code: 'STALE', message: 's', fix: 'f' })) },
      });

      const verified = await call('POST', '/auth/verify-email', { token: await confirmationToken(session) }, session.accessToken);
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json().data).toEqual({ ok: true, emailVerified: true });
      expect(verified.json().data, 'the link gives nobody a session').not.toHaveProperty('accessToken');

      const after = await prisma.tenantUser.findUniqueOrThrow({ where: { id: session.user.id } });
      expect(after.emailVerified).toBe(true);
      expect(after.passwordHash, 'the password chosen at sign-up is kept').toBe(row.passwordHash);
      expect(after.sessionsInvalidBefore).toBeNull();
      expect((await me(session)).statusCode, 'the session from before the link still works').toBe(200);
      expect((await me(session)).json().data.user.emailVerified).toBe(true);
      expect((await call('POST', '/auth/refresh', { refreshToken: session.refreshToken })).statusCode).toBe(200);
      expect((await call('POST', '/auth/sign-in', { email: session.user.email, password: PASSWORD })).statusCode).toBe(200);
      expect((await prisma.tenantApiToken.findUniqueOrThrow({ where: { id: token.id } })).revokedAt).toBeNull();
      expect(await prisma.tenantMcpRefreshToken.count({ where: { tenantUserId: session.user.id, revokedAt: null } })).toBe(1);
      expect(
        await prisma.securityEvent.count({ where: { actorId: session.user.id, type: 'auth.unverified_account_claimed' } }),
        'ratification is not a claim',
      ).toBe(0);
      await vi.waitFor(async () =>
        expect(await prisma.securityEvent.count({ where: { actorId: session.user.id, type: 'operator.email_confirmed' } })).toBe(1),
      );
    });

    it('works once: a second use answers 401 EMAIL_VERIFICATION_TOKEN_USED, and its fix is true', async () => {
      const session = await signUp();
      const token = await confirmationToken(session);
      expect((await call('POST', '/auth/verify-email', { token }, session.accessToken)).statusCode).toBe(200);
      const again = await call('POST', '/auth/verify-email', { token }, session.accessToken);
      expect(again.statusCode).toBe(401);
      expect(again.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_USED');
      // "GET /api/v1/tenant/auth/me shows `emailVerified`."
      expect((await me(session)).json().data.user.emailVerified).toBe(true);
    });

    it('eight uses of one link at once confirm once', async () => {
      const session = await signUp();
      const token = await confirmationToken(session);
      const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/auth/verify-email', { token }, session.accessToken)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 401)).toHaveLength(7);
      await vi.waitFor(async () =>
        expect(await prisma.securityEvent.count({ where: { actorId: session.user.id, type: 'operator.email_confirmed' } })).toBe(1),
      );
    });

    it('an unknown or expired link answers 401, and a fresh one requested as the fix says then works', async () => {
      const session = await signUp();
      const unknown = await call('POST', '/auth/verify-email', { token: 'not-a-token' }, session.accessToken);
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_INVALID');

      const token = await confirmationToken(session);
      await prisma.tenantEmailVerificationToken.updateMany({
        where: { tenantUserId: session.user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await call('POST', '/auth/verify-email', { token }, session.accessToken);
      expect(expired.statusCode).toBe(401);
      expect(expired.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_EXPIRED');
      expect((await me(session)).json().data.user.emailVerified).toBe(false);
      // "Sign in and request a fresh confirmation email via POST /api/v1/tenant/auth/resend-verification."
      await confirm(session);
      expect((await me(session)).json().data.user.emailVerified).toBe(true);
    });

    it('a link mailed to an address the account no longer uses is refused', async () => {
      const session = await signUp();
      const token = await confirmationToken(session);
      await prisma.tenantUser.update({ where: { id: session.user.id }, data: { email: `moved-${session.user.email}` } });
      const res = await call('POST', '/auth/verify-email', { token }, session.accessToken);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('EMAIL_VERIFICATION_STALE');
      expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: session.user.id } })).emailVerified).toBe(false);
    });

    it('needs a session: the link by itself confirms nothing, and the fix for someone who did not create the account removes the squatter\'s password', async () => {
      // Someone registers an address they cannot read. The confirmation link
      // goes to the real owner, who did not create the account.
      const squatter = await signUp('victim');
      const token = await confirmationToken(squatter);
      const withoutSession = await call('POST', '/auth/verify-email', { token });
      expect(withoutSession.statusCode, withoutSession.body).toBe(401);
      expect(withoutSession.json().error.code).toBe('TENANT_SESSION_MISSING');
      const fix = String(withoutSession.json().error.fix);
      expect(fix).toContain('/api/v1/tenant/auth/sign-in');
      expect(fix).toContain('/api/v1/tenant/auth/magic-link/request');
      const row = () => prisma.tenantUser.findUniqueOrThrow({ where: { id: squatter.user.id } });
      expect((await row()).emailVerified, 'nothing was confirmed').toBe(false);
      expect((await prisma.tenantEmailVerificationToken.findFirstOrThrow({ where: { tenantUserId: squatter.user.id }, orderBy: { createdAt: 'desc' } })).consumedAt, 'and the link was not spent').toBeNull();

      // The owner cannot do the first thing the fix says (they do not know the
      // password), so they do the second: an emailed sign-in link.
      const link = await call('POST', '/auth/magic-link/request', { email: squatter.user.email });
      const signedIn = await call('POST', '/auth/magic-link/verify', { token: (link.json().data as { token: string }).token });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      expect((await row()).emailVerified, 'which confirms the address').toBe(true);
      expect((await row()).passwordHash, 'and removes the password set before').toBeNull();
      expect((await call('POST', '/auth/sign-in', { email: squatter.user.email, password: PASSWORD })).statusCode).toBe(401);
      expect((await me(squatter)).statusCode, 'the squatter is signed out').toBe(401);
    });

    it('the person who created the account follows the first half of the fix: sign in, then confirm', async () => {
      const mine = await signUp('mine');
      const token = await confirmationToken(mine);
      const signIn = await call('POST', '/auth/sign-in', { email: mine.user.email, password: PASSWORD });
      const accessToken = (signIn.json().data as { accessToken: string }).accessToken;
      const confirmed = await call('POST', '/auth/verify-email', { token }, accessToken);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
    });

    it('refuses a link that belongs to another account, without spending it: 403 EMAIL_VERIFICATION_WRONG_ACCOUNT', async () => {
      const target = await signUp('target');
      const other = await signUp('other');
      const token = await confirmationToken(target);
      const res = await call('POST', '/auth/verify-email', { token }, other.accessToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_VERIFICATION_WRONG_ACCOUNT');
      expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: target.user.id } })).emailVerified).toBe(false);
      expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: other.user.id } })).emailVerified).toBe(false);
      // "Sign in as the account the confirmation email was sent to, then open the link again."
      const again = await call('POST', '/auth/verify-email', { token }, target.accessToken);
      expect(again.statusCode, again.body).toBe(200);
    });

    it('an invalid session is refused like anywhere else, and nothing is confirmed', async () => {
      const session = await signUp();
      const token = await confirmationToken(session);
      const res = await call('POST', '/auth/verify-email', { token }, 'not-a-session-token');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TENANT_SESSION_INVALID');
      expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: session.user.id } })).emailVerified).toBe(false);
    });

    it('tells the address afterwards that it was confirmed, outside the recipient cap', async () => {
      const session = await signUp();
      const dispatch = vi.spyOn(emailService, 'dispatchSystem');
      await confirm(session);
      await vi.waitFor(() =>
        expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'operator_email_confirmed' && c[0].to === session.user.email)).toHaveLength(1),
      );
      const { defaultTemplate } = await import('../src/modules/email/defaults/index.js');
      const { SYSTEM_BRAND } = await import('../src/modules/email/defaults/brand.js');
      expect(defaultTemplate('operator_email_confirmed', SYSTEM_BRAND).text).toContain('reset the password');
    });

    it('a newer confirmation email replaces the earlier one: the old link stops working and one row is kept', async () => {
      const session = await signUp();
      const first = await confirmationToken(session);
      const second = await confirmationToken(session);
      expect(
        await prisma.tenantEmailVerificationToken.count({ where: { tenantUserId: session.user.id } }),
        'the one from sign-up and the first resend are gone',
      ).toBe(1);
      const old = await call('POST', '/auth/verify-email', { token: first }, session.accessToken);
      expect(old.statusCode).toBe(401);
      expect(old.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_INVALID');
      expect(String(old.json().error.fix)).toContain('newest');
      expect((await me(session)).json().data.user.emailVerified).toBe(false);
      // The fix, followed: the newest link works.
      expect((await call('POST', '/auth/verify-email', { token: second }, session.accessToken)).statusCode).toBe(200);
      // A used link is kept until it expires, so opening it twice still says "already used".
      const again = await call('POST', '/auth/verify-email', { token: second }, session.accessToken);
      expect(again.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_USED');
    });

    it('asking again when already confirmed sends nothing and says so', async () => {
      const session = await signUp();
      await confirm(session);
      const dispatch = vi.spyOn(emailService, 'dispatchSystem');
      const res = await call('POST', '/auth/resend-verification', {}, session.accessToken);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ emailSent: false, alreadyVerified: true, verificationToken: null });
      expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'operator_email_verification')).toHaveLength(0);
    });

    it('where the deployment cannot send mail, asking answers 409 with only the remedies that exist', async () => {
      const session = await signUp();
      vi.spyOn(operatorConfirmation, 'ways').mockReturnValue({ mail: false, provider: true, handoff: false });
      const res = await call('POST', '/auth/resend-verification', {}, session.accessToken);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('OPERATOR_CONFIRMATION_EMAIL_UNAVAILABLE');
      const fix = String(res.json().error.fix);
      expect(fix).toContain('a sign-in provider the panel offers');
      expect(fix).not.toContain('resend-verification');
      expect(fix).not.toContain('forgot-password');
      expect(fix).not.toContain('magic-link');
    });

    it('needs a session to ask for one', async () => {
      expect((await call('POST', '/auth/resend-verification', {})).statusCode).toBe(401);
    });
  });

  describe('what an unconfirmed operator may not do', () => {
    interface Workspace {
      owner: Session;
      appId: string;
      memberMembershipId: string;
      memberUserId: string;
      endpointId: string;
    }

    /** A workspace with an Application, a second member and a webhook endpoint, owned by an unconfirmed operator. */
    async function workspace(): Promise<Workspace> {
      const owner = await signUp('owner');
      const created = await call('POST', '/applications/', { name: 'App', slug: `app-${Math.random().toString(36).slice(2, 8)}` }, owner.accessToken);
      expect(created.statusCode, 'creating an Application is ordinary work').toBe(201);
      const appId = (created.json().data as { id: string }).id;
      const member = await prisma.tenantUser.create({
        data: { email: `member-${Math.random().toString(36).slice(2, 8)}@example.com`, emailVerified: true },
      });
      const membership = await prisma.tenantMembership.create({
        data: { tenantUserId: member.id, tenantId: owner.activeTenantId, role: 'MEMBER' },
      });
      const endpoint = await prisma.webhookEndpoint.create({
        data: { applicationId: appId, url: 'https://example.com/existing', events: ['user.created'], secret: 'whsec_x' },
      });
      return { owner, appId, memberMembershipId: membership.id, memberUserId: member.id, endpointId: endpoint.id };
    }

    type Attempt = [string, 'POST' | 'PUT' | 'PATCH', (w: Workspace) => string, (w: Workspace) => unknown];
    const gated: Attempt[] = [
      ['invite someone to the workspace', 'POST', () => '/workspace/invitations', () => ({ email: 'second-owner@example.com', role: 'OWNER' })],
      ['create another workspace', 'POST', () => '/workspace/', () => ({ name: 'Another' })],
      ["change a member's role", 'PATCH', (w) => `/workspace/members/${w.memberMembershipId}`, () => ({ role: 'OWNER' })],
      ['grant a member an Application', 'PUT', (w) => `/workspace/members/${w.memberMembershipId}/grants`, (w) => ({ applicationId: w.appId, role: 'APP_ADMIN' })],
      ['mint an API key', 'POST', (w) => `/applications/${w.appId}/api-keys`, () => ({ name: 'server', mode: 'live' })],
      ['rotate the publishable key', 'POST', (w) => `/applications/${w.appId}/rotate-public-key`, () => ({})],
      ['add a webhook endpoint', 'POST', (w) => `/applications/${w.appId}/webhooks`, () => ({ url: 'https://attacker.example/hook', events: ['*'] })],
      ['change a webhook endpoint', 'PATCH', (w) => `/applications/${w.appId}/webhooks/${w.endpointId}`, () => ({ url: 'https://attacker.example/hook' })],
      ['rotate a webhook secret', 'POST', (w) => `/applications/${w.appId}/webhooks/${w.endpointId}/rotate-secret`, () => ({})],
      ['store billing credentials', 'PUT', (w) => `/applications/${w.appId}/billing-credentials/stripe`, () => ({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' })],
      ['change billing credentials', 'PATCH', (w) => `/applications/${w.appId}/billing-credentials/stripe`, () => ({ webhookSecret: 'whsec_y' })],
      ['register a billing webhook', 'POST', (w) => `/applications/${w.appId}/billing-credentials/stripe/register-webhook`, () => ({})],
      ['configure a sign-in provider', 'PUT', (w) => `/applications/${w.appId}/oauth-config/google`, () => ({ clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'https://app.example.com/cb' })],
      ['change the app URL', 'PATCH', (w) => `/applications/${w.appId}/auth-config`, () => ({ appUrl: 'https://attacker.example' })],
      ['change redirect URLs', 'PATCH', (w) => `/applications/${w.appId}/auth-config`, () => ({ redirectUrls: ['https://attacker.example/cb'] })],
      ['change allowed origins', 'PUT', (w) => `/applications/${w.appId}/access`, () => ({ ipAllowlist: [], corsOrigins: ['https://attacker.example'] })],
      ['set email credentials', 'PUT', (w) => `/applications/${w.appId}/email-credentials`, () => ({ provider: 'resend', apiKey: 're_x', fromAddress: 'a@attacker.example' })],
      ['change the sender address', 'PATCH', (w) => `/applications/${w.appId}/email-sender`, () => ({ fromAddress: 'a@attacker.example' })],
      ['replace a sign-in email template', 'PUT', (w) => `/applications/${w.appId}/email-templates/password_reset`, () => ({ subject: 's', html: '<a href="https://attacker.example/?t={{resetUrl}}">x</a>' })],
    ];

    it.each(gated)('%s: 403 EMAIL_NOT_VERIFIED before a confirmed address, and not after', async (_what, method, url, payload) => {
      const w = await workspace();
      const refused = await call(method, url(w), payload(w), w.owner.accessToken);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(String(refused.json().error.fix)).toContain('/api/v1/tenant/auth/resend-verification');

      // The first remedy in the fix, followed literally.
      await confirm(w.owner);
      const after = await call(method, url(w), payload(w), w.owner.accessToken);
      expect(after.json().error?.code, after.body).not.toBe('EMAIL_NOT_VERIFIED');
      expect(after.statusCode, 'the confirmed address is past the gate').not.toBe(403);
    });

    it('nothing was created by the refused calls', async () => {
      const w = await workspace();
      for (const [, method, url, payload] of gated) await call(method, url(w), payload(w), w.owner.accessToken);
      expect(await prisma.tenantInvitation.count({ where: { tenantId: w.owner.activeTenantId } })).toBe(0);
      expect(await prisma.tenantMembership.count({ where: { tenantUserId: w.owner.user.id } })).toBe(1);
      expect(await prisma.apiKey.count({ where: { applicationId: w.appId } })).toBe(0);
      expect(await prisma.webhookEndpoint.findMany({ where: { applicationId: w.appId }, select: { url: true, secret: true } })).toEqual([
        { url: 'https://example.com/existing', secret: 'whsec_x' },
      ]);
      expect((await prisma.tenantMembership.findUniqueOrThrow({ where: { id: w.memberMembershipId } })).role).toBe('MEMBER');
      const app2 = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
      expect(JSON.stringify(app2.authConfig)).not.toContain('attacker.example');
      expect(app2.corsOrigins).toEqual([]);
    });

    it('ordinary work stays open: an Application, a plan, auth settings that are not URLs, reading, revoking', async () => {
      const w = await workspace();
      const t = w.owner.accessToken;
      const plan = await call('POST', `/applications/${w.appId}/plans`, { slug: 'pro', name: 'Pro', kind: 'SUBSCRIPTION', interval: 'MONTH', price: { currency: 'USD', amount: 900 } }, t);
      expect(plan.statusCode, plan.body).toBe(201);
      const settings = await call('PATCH', `/applications/${w.appId}/auth-config`, { passwordMinLength: 12, mfa: 'optional' }, t);
      expect(settings.statusCode, settings.body).toBe(200);
      expect((await call('GET', `/applications/${w.appId}/api-keys`, undefined, t)).statusCode).toBe(200);
      expect((await call('GET', '/workspace/members', undefined, t)).statusCode).toBe(200);
      expect((await call('GET', `/applications/${w.appId}/webhooks`, undefined, t)).statusCode).toBe(200);
      const removed = await call('DELETE', `/applications/${w.appId}/webhooks/${w.endpointId}`, undefined, t);
      expect(removed.statusCode, 'taking a data stream away is always allowed').toBeLessThan(300);
    });

    it('accepting an invitation into someone else\'s workspace is allowed', async () => {
      const host = await signUp('host');
      await confirm(host);
      const guest = await signUp('guest');
      const invited = await call('POST', '/workspace/invitations', { email: guest.user.email, role: 'MEMBER' }, host.accessToken);
      expect(invited.statusCode, invited.body).toBe(201);
      const accepted = await call('POST', '/invitations/accept', { token: (invited.json().data as { token: string }).token }, guest.accessToken);
      expect(accepted.statusCode, accepted.body).toBe(200);
    });

    it('a deployment with no way to confirm an address refuses none of it', async () => {
      const w = await workspace();
      vi.spyOn(operatorConfirmation, 'possible').mockReturnValue(false);
      const key = await call('POST', `/applications/${w.appId}/api-keys`, { name: 'server', mode: 'live' }, w.owner.accessToken);
      expect(key.statusCode, key.body).toBe(201);
      const invited = await call('POST', '/workspace/invitations', { email: 'colleague@example.com', role: 'MEMBER' }, w.owner.accessToken);
      expect(invited.statusCode, invited.body).toBe(201);
    });

    it('the operator MCP tools are refused the same way, for a grant that predates the rule', async () => {
      const w = await workspace();
      await prisma.tenant.update({ where: { id: w.owner.activeTenantId }, data: { operatorMcpEnabled: true } });
      const row = await prisma.tenantUser.findUniqueOrThrow({ where: { id: w.owner.user.id } });
      const issued = await operatorMcpOAuthService.issueTokens({
        tenantUserId: w.owner.user.id,
        tenantId: w.owner.activeTenantId,
        clientId: 'client-1',
        scope: 'mcp:operator:read mcp:operator:write mcp:operator:admin',
        grant: { basis: sessionBasis(row, () => new RekeyError({ statusCode: 400, code: 'STALE', message: 's', fix: 'f' })) },
      });
      const tool = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: Record<string, unknown> }> => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/tenant/mcp',
          headers: { authorization: `Bearer ${String(issued!.access_token)}` },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        });
        const parsed = res.json() as { result?: { content: Array<{ text: string }>; isError?: boolean } };
        expect(parsed.result, res.body).toBeDefined();
        return { isError: parsed.result!.isError === true, data: JSON.parse(parsed.result!.content[0]!.text) };
      };
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['invite_member', { email: 'second-owner@example.com', role: 'OWNER' }],
        ['mint_api_key', { applicationId: w.appId, name: 'stolen' }],
        ['create_webhook_endpoint', { applicationId: w.appId, url: 'https://attacker.example/hook', events: ['*'] }],
        ['update_webhook_endpoint', { applicationId: w.appId, endpointId: w.endpointId, url: 'https://attacker.example/hook' }],
        ['update_auth_config', { applicationId: w.appId, appUrl: 'https://attacker.example' }],
        ['change_member_role', { tenantUserId: w.memberUserId, newRole: 'OWNER' }],
        ['configure_billing_provider', { applicationId: w.appId, provider: 'stripe', secretKey: 'sk_test_x' }],
      ];
      for (const [name, args] of attempts) {
        const out = await tool(name, args);
        expect(out.isError, `${name}: ${JSON.stringify(out.data)}`).toBe(true);
        expect(JSON.stringify(out.data), name).toContain('EMAIL_NOT_VERIFIED');
      }
      const read = await tool('list_applications', {});
      expect(read.isError, 'reading is still allowed').toBe(false);

      await confirm(w.owner);
      const minted = await tool('mint_api_key', { applicationId: w.appId, name: 'mine' });
      expect(JSON.stringify(minted.data)).not.toContain('EMAIL_NOT_VERIFIED');
      expect(minted.isError, JSON.stringify(minted.data)).toBe(false);
    });

    it('a personal access token from before the rule cannot mint a key either, until its operator confirms', async () => {
      const w = await workspace();
      // A token minted when nothing was refused: before this release, or on a
      // deployment that could not confirm an address at the time.
      const possible = vi.spyOn(operatorConfirmation, 'possible').mockReturnValue(false);
      const minted = await call('POST', '/auth/api-tokens', { name: 'ci', scopes: ['read', 'keys:mint'] }, w.owner.accessToken);
      expect(minted.statusCode, minted.body).toBe(201);
      const pat = (minted.json().data as { rawToken: string }).rawToken;
      possible.mockRestore();

      const mint = (): Promise<LightMyRequestResponse> =>
        call('POST', `/operator/applications/${w.appId}/api-keys`, { name: 'from-ci', mode: 'live' }, pat);
      const refused = await mint();
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await prisma.apiKey.count({ where: { applicationId: w.appId } })).toBe(0);
      expect((await call('GET', '/operator/applications', undefined, pat)).statusCode, 'the token still reads').toBe(200);

      await confirm(w.owner);
      const after = await mint();
      expect(after.statusCode, after.body).toBe(201);
      expect((await prisma.apiKey.findFirstOrThrow({ where: { applicationId: w.appId } })).createdByTenantUserId).toBe(w.owner.user.id);
    });

    it('the new columns that say who created a key or an endpoint are not on the wire', async () => {
      const owner = await signUp('creator');
      await confirm(owner);
      const t = owner.accessToken;
      const created = await call('POST', '/applications/', { name: 'App', slug: `app-${Math.random().toString(36).slice(2, 8)}` }, t);
      const appId = (created.json().data as { id: string }).id;
      const key = await call('POST', `/applications/${appId}/api-keys`, { name: 'server', mode: 'live' }, t);
      const hook = await call('POST', `/applications/${appId}/webhooks`, { url: 'https://example.com/hook', events: ['user.created'] }, t);
      expect(key.statusCode).toBe(201);
      expect(hook.statusCode).toBe(201);
      expect((await prisma.apiKey.findFirstOrThrow({ where: { applicationId: appId } })).createdByTenantUserId).toBe(owner.user.id);
      expect((await prisma.webhookEndpoint.findFirstOrThrow({ where: { applicationId: appId } })).createdByTenantUserId).toBe(owner.user.id);
      const bodies = [
        key.body,
        hook.body,
        (await call('GET', `/applications/${appId}/api-keys`, undefined, t)).body,
        (await call('GET', `/applications/${appId}/webhooks`, undefined, t)).body,
        (await me(owner)).body,
      ];
      for (const body of bodies) {
        expect(body).not.toContain('createdByTenantUserId');
        expect(body).not.toContain('created_by_tenant_user_id');
      }
    });
  });
});
