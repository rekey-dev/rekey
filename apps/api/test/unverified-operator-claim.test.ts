/**
 * Pre-registration takeover of an operator account.
 *
 * Operator sign-up needs no proof of the address either, and there is no
 * verification step afterwards. Whoever registers someone else's address keeps
 * a working password while the real owner signs in by emailed link, Google or
 * a reset, joins a workspace and enters billing credentials. Proving the
 * mailbox has to end everything set before the proof.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { GoogleProvider } from '../src/modules/oauth/providers/google.js';

const ATTACKER_PASSWORD = 'attacker-pw-one-two-three';
const VICTIM_PASSWORD = 'victim-pw-one-two-three';
const RACERS = 8;

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; emailVerified: boolean };
}

describe('Claiming an unverified operator account', () => {
  let app: FastifyInstance;
  let victim: string;
  let oauthEmail = '';

  beforeAll(async () => {
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({ providerAccountId: 'victim-google', email: oauthEmail, emailVerified: true }),
    });
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    registerOAuthProvider(new GoogleProvider());
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const post = (url: string, payload: unknown, accessToken?: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant${url}`,
      ...(accessToken && { headers: { authorization: `Bearer ${accessToken}` } }),
      payload: payload as never,
    });

  async function attackerSignsUp(): Promise<Session> {
    victim = `victim-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const res = await post('/auth/sign-up', { email: victim, password: ATTACKER_PASSWORD, workspaceName: 'Staging' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data as Session;
  }

  async function magicLinkToken(): Promise<string> {
    const res = await post('/auth/magic-link/request', { email: victim });
    const token = (res.json().data as { token: string | null }).token;
    expect(token).toBeTruthy();
    return token!;
  }

  async function resetToken(): Promise<string> {
    const res = await post('/auth/forgot-password', { email: victim });
    const token = (res.json().data as { resetToken: string | null }).resetToken;
    expect(token).toBeTruthy();
    return token!;
  }

  const passwordSignIn = (password = ATTACKER_PASSWORD): Promise<LightMyRequestResponse> =>
    post('/auth/sign-in', { email: victim, password });
  const refresh = (refreshToken: string): Promise<LightMyRequestResponse> => post('/auth/refresh', { refreshToken });
  const me = (accessToken: string): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: { authorization: `Bearer ${accessToken}` } });

  async function expectAttackerLockedOut(attacker: Session): Promise<void> {
    const signIn = await passwordSignIn();
    expect(signIn.statusCode, 'the pre-registered password must stop working').toBe(401);
    expect(signIn.json().error.code).toBe('INVALID_CREDENTIALS');
    expect((await refresh(attacker.refreshToken)).statusCode, 'the pre-registered refresh token must stop working').toBe(401);
    expect((await me(attacker.accessToken)).statusCode, 'the pre-registered access token must stop working').toBe(401);
  }

  it('a magic-link sign-in ends every credential set before the mailbox was proven', async () => {
    const attacker = await attackerSignsUp();
    expect((await me(attacker.accessToken)).statusCode).toBe(200);
    const dispatch = vi.spyOn(emailService, 'dispatchSystem');

    const verified = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
    expect(verified.statusCode, verified.body).toBe(200);
    const prover = verified.json().data as Session;
    expect(prover.user.id).toBe(attacker.user.id);
    expect(prover.user.emailVerified).toBe(true);

    await expectAttackerLockedOut(attacker);
    expect((await me(prover.accessToken)).statusCode, 'the prover keeps a working session').toBe(200);
    expect((await refresh(prover.refreshToken)).statusCode).toBe(200);

    const events = await prisma.securityEvent.findMany({
      where: { type: 'auth.unverified_account_claimed', actorId: attacker.user.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe('operator');
    expect(events[0]!.metadata).toMatchObject({ provenBy: 'magic_link', passwordRemoved: true });
    await vi.waitFor(() =>
      expect(
        dispatch.mock.calls.filter((c) => c[0].eventKey === 'operator_account_claimed' && c[0].to === victim),
      ).toHaveLength(1),
    );
  });

  it('what the first registrant planted in the workspace: their keys and endpoints go, other members are named to the owner', async () => {
    // An account from before operators were held back, or from a deployment
    // that could not confirm an address when it was made: nothing was refused.
    const { operatorConfirmation } = await import('../src/modules/tenant-auth/operator-claim.js');
    const possible = vi.spyOn(operatorConfirmation, 'possible').mockReturnValue(false);
    const attacker = await attackerSignsUp();
    const tenantUserId = attacker.user.id;
    const tenantId = (await prisma.tenantMembership.findFirstOrThrow({ where: { tenantUserId } })).tenantId;
    const t = attacker.accessToken;
    const created = await post('/applications/', { name: 'App', slug: `app-${Math.random().toString(36).slice(2, 8)}` }, t);
    const appId = (created.json().data as { id: string }).id;
    const minted = await post(`/applications/${appId}/api-keys`, { name: 'planted', mode: 'live' }, t);
    expect(minted.statusCode, minted.body).toBe(201);
    const plantedKey = (minted.json().data as { rawKey: string }).rawKey;
    const hook = await post(`/applications/${appId}/webhooks`, { url: 'https://attacker.example/hook', events: ['*'] }, t);
    expect(hook.statusCode, hook.body).toBe(201);
    // Not attributable: a key and an endpoint from before the rows recorded who made them.
    await prisma.apiKey.create({ data: { applicationId: appId, name: 'older', keyPrefix: 'rp_test_old', keyHash: `old-${appId}`, scopes: ['*'] } });
    await prisma.webhookEndpoint.create({ data: { applicationId: appId, url: 'https://example.com/older', events: ['*'], secret: 'whsec_older' } });
    await prisma.billingCredentials.create({
      data: { applicationId: appId, provider: 'stripe', mode: 'test', ciphertext: 'x' },
    });
    // Their second account, already in as an owner.
    const accomplice = await prisma.tenantUser.create({
      data: { email: 'accomplice@attacker.example', name: 'Second Account', emailVerified: true },
    });
    await prisma.tenantMembership.create({ data: { tenantUserId: accomplice.id, tenantId, role: 'OWNER' } });
    // And a workspace the account administers without owning it.
    const elsewhere = await prisma.tenant.create({ data: { name: 'Elsewhere', ownerEmail: 'someone@example.com' } });
    await prisma.tenantMembership.create({ data: { tenantUserId, tenantId: elsewhere.id, role: 'ADMIN' } });
    const viewOnly = await prisma.tenant.create({ data: { name: 'View only', ownerEmail: 'someone@example.com' } });
    await prisma.tenantMembership.create({ data: { tenantUserId, tenantId: viewOnly.id, role: 'MEMBER' } });
    possible.mockRestore();

    let n = 0;
    const withKey = (key: string): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key}` },
        payload: { email: `user-${(n += 1)}@example.com`, password: 'pw-one-two-three' },
      });
    expect((await withKey(plantedKey)).statusCode, 'the planted key works before the claim').toBe(201);

    const dispatch = vi.spyOn(emailService, 'dispatchSystem');
    const verified = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
    expect(verified.statusCode, verified.body).toBe(200);

    expect((await withKey(plantedKey)).statusCode, 'the key the first registrant minted is revoked').toBe(401);
    const keys = await prisma.apiKey.findMany({ where: { applicationId: appId }, orderBy: { createdAt: 'asc' } });
    expect(keys.map((k) => [k.name, k.revokedAt !== null])).toEqual([['planted', true], ['older', false]]);
    const hooks = await prisma.webhookEndpoint.findMany({ where: { applicationId: appId }, orderBy: { createdAt: 'asc' } });
    expect(hooks.map((h) => [h.url, h.enabled]), 'switched off, not deleted; an unattributed one is left').toEqual([
      ['https://attacker.example/hook', false],
      ['https://example.com/older', true],
    ]);
    expect(
      await prisma.tenantMembership.count({ where: { tenantId, tenantUserId: accomplice.id } }),
      'other members are never removed automatically',
    ).toBe(1);

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { type: 'auth.unverified_account_claimed', actorId: tenantUserId },
    });
    expect(event.metadata).toMatchObject({
      apiKeysRevoked: 1,
      webhookEndpointsDisabled: 1,
      review: [
        {
          tenantId,
          tenantName: 'Staging',
          role: 'OWNER',
          otherMembers: [{ name: 'Second Account', email: 'accomplice@attacker.example', role: 'OWNER' }],
          otherMembersNotListed: 0,
          applications: 1,
          liveApiKeys: 1,
          unattributedApiKeys: 1,
          webhookEndpoints: 1,
          unattributedWebhookEndpoints: 1,
          billingProviders: 1,
        },
        { tenantId: elsewhere.id, tenantName: 'Elsewhere', role: 'ADMIN', applications: 0, liveApiKeys: 0 },
      ],
    });
    expect(
      (event.metadata as { review: unknown[] }).review,
      'a workspace the account can only work in, not administer, is not its to review',
    ).toHaveLength(2);

    await vi.waitFor(() =>
      expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'operator_account_claimed')).toHaveLength(1),
    );
    const notice = dispatch.mock.calls.find((c) => c[0].eventKey === 'operator_account_claimed')![0];
    expect(notice.to).toBe(victim);
    const summary = String(notice.variables.reviewSummary);
    expect(summary).toBe(
      'Workspace "Staging" (you are OWNER): 1 other member (Second Account, accomplice@attacker.example, OWNER); 1 Application; 1 live API key, of which 1 has no recorded creator and was not revoked; 1 webhook endpoint switched on, of which 1 has no recorded creator and was not switched off; 1 billing provider configured. ' +
        'Workspace "Elsewhere" (you are ADMIN): no other members; 0 Applications; 0 live API keys; 0 webhook endpoints switched on; 0 billing providers configured.',
    );
    const { defaultTemplate } = await import('../src/modules/email/defaults/index.js');
    const { SYSTEM_BRAND } = await import('../src/modules/email/defaults/brand.js');
    const text = defaultTemplate('operator_account_claimed', SYSTEM_BRAND).text;
    expect(text).toContain('{{reviewSummary}}');
    expect(text).toContain('remove any member you do not recognise');
    expect(text).toContain('Disable any Application you did not create');
    expect(text).toContain('Settings, then "Disable application"');
    expect(text).toContain('no recorded creator');
    expect(text, 'the claim does change more than sign-in details, and leaves more than it changes').not.toContain('Nothing else was changed');
    expect(text, 'the sentence that was false is gone').not.toContain('everything in it are unchanged');
    expect(defaultTemplate('account_claimed', SYSTEM_BRAND).text).not.toContain('everything in it are unchanged');
  });

  it('an impersonation the first registrant started ends with the claim, and with a later sign-out everywhere', async () => {
    const attacker = await attackerSignsUp();
    const t = attacker.accessToken;
    const created = await post('/applications/', { name: 'App', slug: `imp-${Math.random().toString(36).slice(2, 8)}` }, t);
    const appId = (created.json().data as { id: string }).id;
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.create({ data: { applicationId: appId, email: 'customer@example.com', emailVerified: true } });
    const impersonate = async (accessToken: string): Promise<string> => {
      const started = await post(`/applications/${appId}/end-users/${endUser.id}/impersonate`, { reason: 'looking' }, accessToken);
      expect(started.statusCode, started.body).toBeLessThan(300);
      return (started.json().data as { accessToken: string }).accessToken;
    };
    const asCustomer = (token: string): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${application.publicKey}`, 'x-rekey-user-token': token },
      });

    const before = await impersonate(t);
    expect((await asCustomer(before)).statusCode).toBe(200);
    const verified = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
    expect(verified.statusCode, verified.body).toBe(200);
    expect((await asCustomer(before)).statusCode, 'the token minted before the claim is dead').toBe(401);
    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { type: 'auth.unverified_account_claimed', actorId: attacker.user.id },
    });
    expect(event.metadata).toMatchObject({ impersonationsEnded: 1 });

    const owner = (verified.json().data as Session).accessToken;
    const again = await impersonate(owner);
    expect((await asCustomer(again)).statusCode).toBe(200);
    expect((await post('/auth/sign-out-everywhere', {}, owner)).statusCode).toBe(200);
    expect((await asCustomer(again)).statusCode, 'sign-out everywhere ends it too').toBe(401);
  });

  it('a reset that claims the account says so by mail when it removed more than the password, and stays quiet when it did not', async () => {
    const quiet = await attackerSignsUp();
    const dispatch = vi.spyOn(emailService, 'dispatchSystem');
    expect((await post('/auth/reset-password', { token: await resetToken(), newPassword: VICTIM_PASSWORD })).statusCode).toBe(200);
    expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: quiet.user.id } })).emailVerified).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'operator_account_claimed')).toHaveLength(0);

    const attacker = await attackerSignsUp();
    const tenantUserId = attacker.user.id;
    const tenantId = (await prisma.tenantMembership.findFirstOrThrow({ where: { tenantUserId } })).tenantId;
    await prisma.tenantApiToken.create({
      data: { tenantUserId, tenantId, name: 'legacy', tokenPrefix: 'rp_op_legacy', tokenHash: `h-${tenantUserId}`, scopes: ['read'] },
    });
    expect((await post('/auth/reset-password', { token: await resetToken(), newPassword: VICTIM_PASSWORD })).statusCode).toBe(200);
    expect(await prisma.tenantApiToken.count({ where: { tenantUserId, revokedAt: null } })).toBe(0);
    await vi.waitFor(() =>
      expect(
        dispatch.mock.calls.filter((c) => c[0].eventKey === 'operator_account_claimed' && c[0].to === victim),
      ).toHaveLength(1),
    );
  });

  it('removes access tokens, passkeys, MCP grants and invitations the unconfirmed account already had', async () => {
    const attacker = await attackerSignsUp();
    const tenantUserId = attacker.user.id;
    const tenantId = (await prisma.tenantMembership.findFirstOrThrow({ where: { tenantUserId } })).tenantId;
    await prisma.tenantApiToken.create({
      data: { tenantUserId, tenantId, name: 'legacy', tokenPrefix: 'rp_op_legacy', tokenHash: `h-${tenantUserId}`, scopes: ['read'] },
    });
    await prisma.tenantWebAuthnCredential.create({
      data: { tenantUserId, credentialId: `cred-${tenantUserId}`, publicKey: 'AQID' },
    });
    const client = await prisma.tenantOAuthClient.create({
      data: { clientName: 'legacy agent', redirectUris: ['https://agent.example/cb'] },
    });
    await prisma.tenantMcpRefreshToken.create({
      data: { tokenHash: `mcp-${tenantUserId}`, tenantUserId, tenantId, clientId: client.id, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    // Seeded, not sent: an unconfirmed operator can no longer invite anyone
    // (operator-email-confirmation.test.ts). This is one from before that.
    await prisma.tenantInvitation.create({
      data: {
        tenantId,
        email: 'accomplice@example.com',
        role: 'ADMIN',
        tokenHash: `inv-${tenantUserId}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedById: tenantUserId,
      },
    });

    const verified = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
    expect(verified.statusCode).toBe(200);

    expect(await prisma.tenantApiToken.count({ where: { tenantUserId, revokedAt: null } })).toBe(0);
    expect(await prisma.tenantWebAuthnCredential.count({ where: { tenantUserId } })).toBe(0);
    expect(await prisma.tenantMcpRefreshToken.count({ where: { tenantUserId, revokedAt: null } })).toBe(0);
    expect(await prisma.tenantInvitation.count({ where: { invitedById: tenantUserId, revokedAt: null } })).toBe(0);
    expect(await prisma.tenantMembership.count({ where: { tenantUserId } }), 'memberships stay with the row').toBe(1);
  });

  it('a provider that verified the address claims the account', async () => {
    const attacker = await attackerSignsUp();
    oauthEmail = victim;
    const callback = await post('/auth/oauth/google/callback', { code: 'auth-code' });
    expect(callback.statusCode, callback.body).toBe(200);
    const prover = callback.json().data as Session;
    expect(prover.user.id).toBe(attacker.user.id);
    expect(prover.user.emailVerified).toBe(true);
    await expectAttackerLockedOut(attacker);
    expect((await me(prover.accessToken)).statusCode).toBe(200);
  });

  it('completing a password reset claims the account: the new password works, nothing older does', async () => {
    const attacker = await attackerSignsUp();
    const reset = await post('/auth/reset-password', { token: await resetToken(), newPassword: VICTIM_PASSWORD });
    expect(reset.statusCode, reset.body).toBe(200);

    await expectAttackerLockedOut(attacker);
    const signIn = await passwordSignIn(VICTIM_PASSWORD);
    expect(signIn.statusCode).toBe(200);
    expect((signIn.json().data as Session).user.emailVerified).toBe(true);
  });

  it('a confirmed operator keeps the password across a later magic link', async () => {
    const attacker = await attackerSignsUp();
    await post('/auth/reset-password', { token: await resetToken(), newPassword: VICTIM_PASSWORD });
    const verified = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
    expect(verified.statusCode).toBe(200);
    expect((await passwordSignIn(VICTIM_PASSWORD)).statusCode).toBe(200);
    const claims = await prisma.securityEvent.findMany({
      where: { type: 'auth.unverified_account_claimed', actorId: attacker.user.id },
    });
    expect(claims.map((e) => (e.metadata as { provenBy: string }).provenBy)).toEqual(['password_reset']);
  });

  it('accepting an invitation confirms nothing: the inviter holds that token too', async () => {
    const attacker = await attackerSignsUp();
    const inviter = await post('/auth/sign-up', { email: 'second-attacker@example.com', password: ATTACKER_PASSWORD, workspaceName: 'Other' });
    // The inviter has confirmed an address of their own, which an attacker can do for theirs.
    await prisma.tenantUser.update({
      where: { id: (inviter.json().data as Session).user.id },
      data: { emailVerified: true },
    });
    const invitation = await post(
      '/workspace/invitations',
      { email: victim, role: 'MEMBER' },
      (inviter.json().data as Session).accessToken,
    );
    const token = (invitation.json().data as { token: string }).token;
    const accepted = await post('/invitations/accept', { token }, attacker.accessToken);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } })).emailVerified).toBe(false);

    await post('/auth/magic-link/verify', { token: await magicLinkToken() });
    await expectAttackerLockedOut(attacker);
  });

  describe('an unconfirmed operator that already has a second factor', () => {
    async function enrolledUnverified(): Promise<{ attacker: Session; totp: OTPAuth.TOTP }> {
      const attacker = await attackerSignsUp();
      await prisma.tenantUser.update({ where: { id: attacker.user.id }, data: { emailVerified: true } });
      const setup = await post('/auth/mfa/setup', {}, attacker.accessToken);
      expect(setup.statusCode, setup.body).toBe(201);
      const totp = OTPAuth.URI.parse((setup.json().data as { otpauthUrl: string }).otpauthUrl) as OTPAuth.TOTP;
      const confirmed = await post(
        '/auth/mfa/setup-confirm',
        { code: totp.generate({ timestamp: Date.now() - 30_000 }) },
        attacker.accessToken,
      );
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      await prisma.tenantUser.update({ where: { id: attacker.user.id }, data: { emailVerified: false } });
      return { attacker, totp };
    }

    it('is told how to confirm in words that are true with two-factor on, and each remedy does what it says', async () => {
      const { attacker, totp } = await enrolledUnverified();
      const refused = await post('/auth/api-tokens', { name: 'ci' }, attacker.accessToken);
      expect(refused.statusCode).toBe(403);
      const fix = String(refused.json().error.fix);
      expect(fix, 'a reset confirms nothing while a second factor is on, so it is not offered').not.toContain('forgot-password');
      expect(fix).not.toContain('reset');
      expect(fix).toContain('once you enter your two-factor code, and removes nothing');
      expect(fix).toContain('/api/v1/tenant/auth/resend-verification');

      // What the fix leaves out, checked: completing a reset does not confirm.
      await post('/auth/reset-password', { token: await resetToken(), newPassword: VICTIM_PASSWORD });
      expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } })).emailVerified).toBe(false);

      // Second remedy, literally: an emailed link, then the code. Confirms, removes nothing.
      const link = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
      const challenge = link.json().data as { mfaRequired: boolean; mfaChallengeToken: string };
      expect(challenge.mfaRequired).toBe(true);
      const passed = await post('/auth/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: totp.generate() });
      expect(passed.statusCode, passed.body).toBe(200);
      const after = await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } });
      expect(after.emailVerified).toBe(true);
      expect(after.passwordHash, 'removes nothing').not.toBeNull();
      expect(await prisma.tenantMfaCredential.count({ where: { tenantUserId: attacker.user.id } })).toBe(1);
      const session = passed.json().data as Session;
      expect((await post('/auth/api-tokens', { name: 'ci' }, session.accessToken)).statusCode).toBe(201);
    });

    it('the confirmation email works with two-factor on, and keeps the factor and the password', async () => {
      const { attacker } = await enrolledUnverified();
      const sent = await post('/auth/resend-verification', {}, attacker.accessToken);
      const token = (sent.json().data as { verificationToken: string }).verificationToken;
      expect((await post('/auth/verify-email', { token }, attacker.accessToken)).statusCode).toBe(200);
      const after = await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } });
      expect(after.emailVerified).toBe(true);
      expect(after.passwordHash).not.toBeNull();
      expect(await prisma.tenantMfaCredential.count({ where: { tenantUserId: attacker.user.id } })).toBe(1);
      expect((await post('/auth/api-tokens', { name: 'ci' }, attacker.accessToken)).statusCode).toBe(201);
    });

    it('without two-factor, each remedy in the fix does what it says', async () => {
      const first = await attackerSignsUp();
      const refused = await post('/auth/api-tokens', { name: 'ci' }, first.accessToken);
      const fix = String(refused.json().error.fix);
      expect(fix).toContain('That changes nothing else: your password, access tokens and MCP grants stay.');
      expect(fix).toContain('also confirms it, and removes the current password, passkeys, access tokens and MCP grants.');
      expect(fix).toContain('So does completing a password reset');
      // Remedy two: an emailed link removes the current password.
      const link = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
      expect(link.statusCode).toBe(200);
      expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: first.user.id } })).passwordHash).toBeNull();
      expect((await post('/auth/api-tokens', { name: 'ci' }, (link.json().data as Session).accessToken)).statusCode).toBe(201);
      // Remedy three: a reset keeps the password chosen there.
      const second = await attackerSignsUp();
      await post('/auth/reset-password', { token: await resetToken(), newPassword: VICTIM_PASSWORD });
      const signedIn = await passwordSignIn(VICTIM_PASSWORD);
      expect(signedIn.statusCode).toBe(200);
      expect((signedIn.json().data as Session).user.id).toBe(second.user.id);
      expect((signedIn.json().data as Session).user.emailVerified).toBe(true);
    });

    it('is neither wiped nor promoted by a magic link until the code is given', async () => {
      const { attacker } = await enrolledUnverified();
      const verified = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
      const challenge = verified.json().data as { mfaRequired: boolean; mfaChallengeToken: string };
      expect(challenge.mfaRequired).toBe(true);
      const wrong = await post('/auth/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: '000000' });
      expect(wrong.statusCode).toBe(401);
      const row = await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } });
      expect(row.emailVerified).toBe(false);
      expect(row.passwordHash).not.toBeNull();
      expect((await refresh(attacker.refreshToken)).statusCode).toBe(200);
    });

    it('is promoted with everything kept once the prover passes the challenge', async () => {
      const { attacker, totp } = await enrolledUnverified();
      const verified = await post('/auth/magic-link/verify', { token: await magicLinkToken() });
      const challenge = verified.json().data as { mfaChallengeToken: string };
      const passed = await post('/auth/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: totp.generate() });
      expect(passed.statusCode, passed.body).toBe(200);
      const row = await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } });
      expect(row.emailVerified).toBe(true);
      expect(row.passwordHash).not.toBeNull();
      expect(await prisma.tenantMfaCredential.count({ where: { tenantUserId: row.id } })).toBe(1);
    });

    it('a password sign-in challenge proves no mailbox, so passing it promotes nothing', async () => {
      const { attacker, totp } = await enrolledUnverified();
      const challenge = (await passwordSignIn()).json().data as { mfaChallengeToken: string };
      const passed = await post('/auth/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: totp.generate() });
      expect(passed.statusCode).toBe(200);
      expect((await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } })).emailVerified).toBe(false);
    });
  });

  describe('an unconfirmed operator cannot gain another way in', () => {
    const refusals: Array<[string, string, Record<string, unknown>]> = [
      ['passkey registration start', '/auth/passkeys/register/start', {}],
      ['passkey registration complete', '/auth/passkeys/register/complete', { response: { id: 'x' }, expectedChallenge: 'c' }],
      ['MFA setup', '/auth/mfa/setup', {}],
      ['MFA setup confirmation', '/auth/mfa/setup-confirm', { code: '123456' }],
      ['access token creation', '/auth/api-tokens', { name: 'ci' }],
    ];

    it.each(refusals)('%s answers 403 EMAIL_NOT_VERIFIED', async (_name, url, payload) => {
      const session = await attackerSignsUp();
      const res = await post(url, payload, session.accessToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('approving an MCP client answers 403 EMAIL_NOT_VERIFIED, and denying one is still allowed', async () => {
      const session = await attackerSignsUp();
      const membership = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantUserId: session.user.id } });
      const registered = await post('/mcp/oauth/register', {
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        client_name: 'Claude',
      });
      const grant = (approve: boolean) =>
        post(
          '/mcp/oauth/grant',
          {
            client_id: registered.json().client_id,
            redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
            code_challenge: 'x'.repeat(43),
            code_challenge_method: 'S256',
            scope: 'mcp:operator:read',
            state: 'st',
            tenant_id: membership.tenantId,
            approve,
          },
          session.accessToken,
        );

      const approved = await grant(true);
      expect(approved.statusCode, approved.body).toBe(403);
      expect(approved.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      expect((await grant(false)).statusCode).toBe(200);
    });

    it('a deployment with no way to confirm an address does not refuse, since nobody could ever claim there', async () => {
      const { operatorConfirmation } = await import('../src/modules/tenant-auth/operator-claim.js');
      expect(operatorConfirmation.possible(), 'this suite runs with operator sign-in providers configured').toBe(true);
      vi.spyOn(operatorConfirmation, 'possible').mockReturnValue(false);
      const session = await attackerSignsUp();
      expect((await post('/auth/api-tokens', { name: 'ci' }, session.accessToken)).statusCode).toBe(201);
    });

    it('nothing was stored by the refused calls', async () => {
      const session = await attackerSignsUp();
      await post('/auth/mfa/setup', {}, session.accessToken);
      await post('/auth/api-tokens', { name: 'ci' }, session.accessToken);
      expect(await prisma.tenantMfaCredential.count({ where: { tenantUserId: session.user.id } })).toBe(0);
      expect(await prisma.tenantApiToken.count({ where: { tenantUserId: session.user.id } })).toBe(0);
    });

    it('the same calls succeed once the address is confirmed by a reset', async () => {
      await attackerSignsUp();
      await post('/auth/reset-password', { token: await resetToken(), newPassword: VICTIM_PASSWORD });
      const session = (await passwordSignIn(VICTIM_PASSWORD)).json().data as Session;
      expect((await post('/auth/api-tokens', { name: 'ci' }, session.accessToken)).statusCode).toBe(201);
      expect((await post('/auth/mfa/setup', {}, session.accessToken)).statusCode).toBe(201);
    });
  });

  it(`${RACERS} sign-in links opened at once produce one claim`, async () => {
    const attacker = await attackerSignsUp();
    const tokens: string[] = [];
    for (let i = 0; i < RACERS; i++) tokens.push(await magicLinkToken());
    const results = await Promise.all(tokens.map((token) => post('/auth/magic-link/verify', { token })));
    for (const r of results) expect([200, 401]).toContain(r.statusCode);
    expect(results.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.securityEvent.count({ where: { type: 'auth.unverified_account_claimed', actorId: attacker.user.id } }),
    ).toBe(1);
    await expectAttackerLockedOut(attacker);
  });
});
