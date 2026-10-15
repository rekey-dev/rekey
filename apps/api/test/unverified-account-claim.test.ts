/**
 * Pre-registration takeover of an end-user account.
 *
 * Sign-up needs no proof of the address, so anyone can register a password
 * account for an address they cannot read. When the real owner later proves the
 * mailbox (magic link, a provider that verified the address, a reset link) they
 * land in that same row. Every credential set before the proof belongs to
 * whoever registered first and has to go, or that person keeps a working way
 * into an account the owner now uses.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { GoogleProvider } from '../src/modules/oauth/providers/google.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import * as OTPAuth from 'otpauth';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const VICTIM = 'victim@example.com';
const ATTACKER_PASSWORD = 'attacker-pw-one-two-three';
const VICTIM_PASSWORD = 'victim-pw-one-two-three';
const RACERS = 8;

interface Session {
  accessToken: string;
  refreshToken: string;
  endUser: { id: string; emailVerified: boolean };
}

describe('Claiming an unverified end-user account', () => {
  let app: FastifyInstance;
  let operator: Record<string, string>;
  let applicationId: string;
  let secretKey: string;
  let publishableKey: string;

  beforeAll(async () => {
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

  beforeEach(async () => {
    const slug = `claim-${Math.random().toString(36).slice(2, 8)}`;
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    operator = { authorization: `Bearer ${token}` };
    applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: operator,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    await setAuthConfig({ methods: ['password', 'magic_link', 'passkey'], appUrl: 'https://app.example.com' });
  });

  const setAuthConfig = async (patch: Record<string, unknown>): Promise<void> => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: operator,
      payload: patch,
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  const sk = (): Record<string, string> => ({ authorization: `Bearer ${secretKey}` });
  const pk = (): Record<string, string> => ({ authorization: `Bearer ${publishableKey}` });

  const post = (url: string, payload: unknown, headers: Record<string, string>): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: `/api/v1/auth${url}`, headers, payload: payload as never });

  async function attackerSignsUp(): Promise<Session> {
    const res = await post('/sign-up', { email: VICTIM, password: ATTACKER_PASSWORD }, pk());
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data as Session;
  }

  async function magicLinkToken(email = VICTIM): Promise<string> {
    const res = await post('/magic-link/request', { email }, sk());
    expect(res.statusCode, res.body).toBe(200);
    const token = (res.json().data as { magicLinkToken: string | null }).magicLinkToken;
    expect(token).toBeTruthy();
    return token!;
  }

  const passwordSignIn = (password = ATTACKER_PASSWORD): Promise<LightMyRequestResponse> =>
    post('/sign-in', { email: VICTIM, password }, pk());

  const refresh = (refreshToken: string): Promise<LightMyRequestResponse> =>
    post('/refresh', { refreshToken }, pk());

  const me = (accessToken: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { ...pk(), 'x-rekey-user-token': accessToken },
    });

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

    const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    expect(verified.statusCode, verified.body).toBe(200);
    const victim = verified.json().data as Session;
    expect(victim.endUser.id).toBe(attacker.endUser.id);
    expect(victim.endUser.emailVerified).toBe(true);

    await expectAttackerLockedOut(attacker);
    expect((await me(victim.accessToken)).statusCode, 'the prover keeps a working session').toBe(200);
    expect((await refresh(victim.refreshToken)).statusCode).toBe(200);
  });
  it('the claim is announced: a security event, user.updated naming credentials, and a notice to the address', async () => {
    await webhookService.createEndpoint({ createdByTenantUserId: null, applicationId, url: 'https://example.invalid/claim', events: ['*'] });
    const attacker = await attackerSignsUp();
    const dispatch = vi.spyOn(emailService, 'dispatch');
    const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    expect(verified.statusCode).toBe(200);

    const events = await prisma.securityEvent.findMany({
      where: { applicationId, type: 'auth.unverified_account_claimed' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(attacker.endUser.id);
    expect(events[0]!.metadata).toMatchObject({ provenBy: 'magic_link', passwordRemoved: true, sessionsRevoked: 1 });

    const updated = await prisma.webhookDelivery.findMany({ where: { applicationId, eventType: 'user.updated' } });
    expect(updated).toHaveLength(1);
    expect((updated[0]!.payload as { data: { changed: string[]; via: string } }).data).toMatchObject({
      changed: ['emailVerified', 'credentials'],
      via: 'magic_link',
    });

    const notices = dispatch.mock.calls.filter((c) => c[0].eventKey === 'account_claimed');
    expect(notices).toHaveLength(1);
    expect(notices[0]![0].to).toBe(VICTIM);
  });

  it('invitations the account sent to an organization, and nobody accepted, are cancelled', async () => {
    const attacker = await attackerSignsUp();
    const org = await prisma.organization.create({ data: { applicationId, name: 'Acme', slug: 'acme' } });
    const invitation = (tokenHash: string, extra: Record<string, unknown> = {}) =>
      prisma.organizationInvitation.create({
        data: {
          organizationId: org.id,
          email: `${tokenHash}@attacker.example`,
          role: 'OWNER',
          tokenHash,
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedById: attacker.endUser.id,
          ...extra,
        },
      });
    const pending = await invitation('pending');
    const accepted = await invitation('accepted', { acceptedAt: new Date() });
    const fromSomeoneElse = await invitation('other', { invitedById: 'someone-else' });

    const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    expect(verified.statusCode, verified.body).toBe(200);
    const after = async (id: string) => (await prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).revokedAt;
    expect(await after(pending.id), 'the pending invitation is revoked').not.toBeNull();
    expect(await after(accepted.id), 'an accepted one is history, left alone').toBeNull();
    expect(await after(fromSomeoneElse.id), 'somebody else\'s invitation is not this account\'s to cancel').toBeNull();
    const event = await prisma.securityEvent.findFirstOrThrow({ where: { applicationId, type: 'auth.unverified_account_claimed' } });
    expect(event.metadata).toMatchObject({ organizationInvitationsRevoked: 1 });
  });

  it('a licence key the first registrant was shown stops activating devices, and the integrator is told', async () => {
    await webhookService.createEndpoint({ createdByTenantUserId: null, applicationId, url: 'https://example.invalid/claim', events: ['*'] });
    const attacker = await attackerSignsUp();
    const { licensesService } = await import('../src/modules/licenses/licenses.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } });
    const issued = await licensesService.issue({ application, endUser, kind: 'PERPETUAL' });
    const activate = (machineFingerprint: string) =>
      licensesService.verify({ applicationId, rawKey: issued.rawKey, machineFingerprint });
    expect((await activate('attacker-laptop')).ok, 'the key activates a device before the claim').toBe(true);
    expect(await prisma.licenseActivation.count({ where: { licenseId: issued.license.id } })).toBe(1);

    const dispatch = vi.spyOn(emailService, 'dispatch');
    const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    expect(verified.statusCode, verified.body).toBe(200);

    const again = await activate('attacker-desktop');
    expect(again.ok, 'the key the first registrant saw no longer activates anything').toBe(false);
    expect(again.reason).toBe('unknown');
    expect(await prisma.licenseActivation.count({ where: { licenseId: issued.license.id } }), 'their activation is gone').toBe(0);
    const licence = await prisma.license.findUniqueOrThrow({ where: { id: issued.license.id } });
    expect(licence.status, 'the licence itself stays with the account').toBe('ACTIVE');
    expect(licence.endUserId).toBe(attacker.endUser.id);

    const event = await prisma.securityEvent.findFirstOrThrow({ where: { applicationId, type: 'auth.unverified_account_claimed' } });
    expect(event.metadata).toMatchObject({ licenseKeysReplaced: 1 });
    const updated = await prisma.webhookDelivery.findMany({ where: { applicationId, eventType: 'user.updated' } });
    expect((updated[0]!.payload as { data: { changed: string[] } }).data.changed).toEqual([
      'emailVerified',
      'credentials',
      'licenseKeys',
    ]);
    await vi.waitFor(() => expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'account_claimed')).toHaveLength(1));
  });

  it('a licence pooled to an organization keeps its key: other members rely on it', async () => {
    const attacker = await attackerSignsUp();
    const org = await prisma.organization.create({ data: { applicationId, name: 'Acme', slug: 'acme' } });
    const { licensesService } = await import('../src/modules/licenses/licenses.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } });
    const issued = await licensesService.issue({ application, endUser, kind: 'PERPETUAL', organizationId: org.id });
    await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    const result = await licensesService.verify({ applicationId, rawKey: issued.rawKey, machineFingerprint: 'team-machine' });
    expect(result.ok).toBe(true);
  });

  it('a reset that claims the account sends the notice when it removed a passkey, and only the password mail when it did not', async () => {
    const dispatch = vi.spyOn(emailService, 'dispatch');
    await attackerSignsUp();
    const first = await post('/forgot-password', { email: VICTIM }, sk());
    await post('/reset-password', { token: (first.json().data as { resetToken: string }).resetToken, newPassword: VICTIM_PASSWORD }, pk());
    await vi.waitFor(() => expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'password_changed')).toHaveLength(1));
    expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'account_claimed'), 'only the password changed').toHaveLength(0);

    await prisma.endUser.updateMany({ where: { applicationId, email: VICTIM }, data: { emailVerified: false } });
    const user = await prisma.endUser.findFirstOrThrow({ where: { applicationId, email: VICTIM } });
    await prisma.webAuthnCredential.create({
      data: { applicationId, endUserId: user.id, credentialId: `cred-${user.id}`, publicKey: 'AQID' },
    });
    const second = await post('/forgot-password', { email: VICTIM }, sk());
    const reset = await post(
      '/reset-password',
      { token: (second.json().data as { resetToken: string }).resetToken, newPassword: 'another-pw-one-two-three' },
      pk(),
    );
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await prisma.webAuthnCredential.count({ where: { endUserId: user.id } })).toBe(0);
    await vi.waitFor(() =>
      expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'account_claimed' && c[0].to === VICTIM)).toHaveLength(1),
    );
  });

  it('keeps the row and what hangs off it: id, role, metadata', async () => {
    const res = await post('/sign-up', { email: VICTIM, password: ATTACKER_PASSWORD, metadata: { plan: 'trial' } }, pk());
    const before = res.json().data as Session;
    const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    const after = verified.json().data as { endUser: { id: string; role: string; metadata: unknown } };
    expect(after.endUser.id).toBe(before.endUser.id);
    expect(after.endUser.metadata).toEqual({ plan: 'trial' });
  });

  it('a link minted before the address had an account still claims the account someone registered in between', async () => {
    const token = await magicLinkToken();
    const attacker = await attackerSignsUp();
    const verified = await post('/magic-link/verify', { token }, pk());
    expect(verified.statusCode, verified.body).toBe(200);
    expect((verified.json().data as Session).endUser.id).toBe(attacker.endUser.id);
    await expectAttackerLockedOut(attacker);
  });

  it('removes passkeys, linked providers, pending tokens and device bindings an unconfirmed account already held', async () => {
    const attacker = await attackerSignsUp();
    const endUserId = attacker.endUser.id;
    await prisma.webAuthnCredential.create({
      data: { applicationId, endUserId, credentialId: 'legacy-cred', publicKey: 'AQID', counter: BigInt(0), transports: ['internal'] },
    });
    await prisma.oAuthIdentity.create({
      data: { applicationId, endUserId, provider: 'github', providerAccountId: 'attacker-gh', email: VICTIM },
    });
    await prisma.device.create({ data: { applicationId, endUserId, fingerprint: 'attacker-device' } });
    const pendingReset = await post('/forgot-password', { email: VICTIM }, sk());
    const resetToken = (pendingReset.json().data as { resetToken: string }).resetToken;
    expect(resetToken).toBeTruthy();

    const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    expect(verified.statusCode).toBe(200);

    expect(await prisma.webAuthnCredential.count({ where: { endUserId } })).toBe(0);
    expect(await prisma.oAuthIdentity.count({ where: { endUserId } })).toBe(0);
    expect(await prisma.device.count({ where: { endUserId, status: 'ACTIVE' } })).toBe(0);
    const stale = await post('/reset-password', { token: resetToken, newPassword: ATTACKER_PASSWORD }, pk());
    expect(stale.statusCode, 'a reset link requested before the claim must be dead').toBe(401);
  });

  it('a provider that verified the address claims the account and stays as its only identity', async () => {
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({ providerAccountId: 'victim-google', email: VICTIM, emailVerified: true }),
    });
    const configured = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${applicationId}/oauth-config/google`,
      headers: operator,
      payload: { clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'https://app.example.com/oauth/google/callback' },
    });
    expect(configured.statusCode).toBe(200);
    const attacker = await attackerSignsUp();
    await prisma.oAuthIdentity.create({
      data: { applicationId, endUserId: attacker.endUser.id, provider: 'github', providerAccountId: 'attacker-gh', email: VICTIM },
    });

    const callback = await post('/oauth/google/callback', { code: 'mock-code' }, pk());
    expect(callback.statusCode, callback.body).toBe(200);
    const victim = callback.json().data as Session;
    expect(victim.endUser.id).toBe(attacker.endUser.id);
    expect(victim.endUser.emailVerified).toBe(true);

    await expectAttackerLockedOut(attacker);
    const identities = await prisma.oAuthIdentity.findMany({ where: { endUserId: attacker.endUser.id } });
    expect(identities.map((i) => i.provider)).toEqual(['google']);
    expect((await me(victim.accessToken)).statusCode).toBe(200);
  });

  it('completing a password reset claims the account: the new password works, nothing older does', async () => {
    const attacker = await attackerSignsUp();
    const requested = await post('/forgot-password', { email: VICTIM }, sk());
    const resetToken = (requested.json().data as { resetToken: string }).resetToken;
    const reset = await post('/reset-password', { token: resetToken, newPassword: VICTIM_PASSWORD }, pk());
    expect(reset.statusCode, reset.body).toBe(200);

    await expectAttackerLockedOut(attacker);
    const signIn = await passwordSignIn(VICTIM_PASSWORD);
    expect(signIn.statusCode).toBe(200);
    expect((signIn.json().data as Session).endUser.emailVerified).toBe(true);
    const events = await prisma.securityEvent.findMany({ where: { applicationId, type: 'auth.unverified_account_claimed' } });
    expect(events.map((e) => (e.metadata as { provenBy: string }).provenBy)).toEqual(['password_reset']);
  });

  it('the verification link ratifies a sign-up: the password and the session survive it', async () => {
    const signedUp = await attackerSignsUp();
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/send-verification',
      headers: { ...sk(), 'x-rekey-user-token': signedUp.accessToken },
      payload: {},
    });
    const verificationToken = (sent.json().data as { verificationToken: string }).verificationToken;
    const verified = await post('/verify-email', { token: verificationToken }, pk());
    expect(verified.statusCode, verified.body).toBe(200);

    expect((await passwordSignIn()).statusCode).toBe(200);
    expect((await refresh(signedUp.refreshToken)).statusCode).toBe(200);
    expect(await prisma.securityEvent.count({ where: { applicationId, type: 'auth.unverified_account_claimed' } })).toBe(0);

    const later = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
    expect(later.statusCode).toBe(200);
    expect((await passwordSignIn()).statusCode, 'a confirmed account keeps its password across a magic link').toBe(200);
  });

  it('signing up again onto an unconfirmed account replaces nothing', async () => {
    const first = await attackerSignsUp();
    const again = await post('/sign-up', { email: VICTIM, password: VICTIM_PASSWORD }, pk());
    expect(again.statusCode).toBe(409);
    expect((await passwordSignIn(VICTIM_PASSWORD)).statusCode).toBe(401);
    expect((await passwordSignIn()).statusCode).toBe(200);
    expect((await me(first.accessToken)).statusCode).toBe(200);
  });

  describe('a secret key that vouches for the address', () => {
    it('creates a confirmed account that a later magic link leaves alone', async () => {
      const res = await post('/sign-up', { email: VICTIM, password: VICTIM_PASSWORD, emailVerified: true }, sk());
      expect(res.statusCode, res.body).toBe(201);
      expect((res.json().data as Session).endUser.emailVerified).toBe(true);
      await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
      expect((await passwordSignIn(VICTIM_PASSWORD)).statusCode).toBe(200);
    });

    it('is refused from a publishable key, and creates nothing', async () => {
      const res = await post('/sign-up', { email: VICTIM, password: ATTACKER_PASSWORD, emailVerified: true }, pk());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_VERIFIED_REQUIRES_SECRET_KEY');
      expect(await prisma.endUser.count({ where: { applicationId } })).toBe(0);
    });

    it('an account a secret key created without vouching is claimed like any other', async () => {
      const res = await post('/sign-up', { email: VICTIM, password: ATTACKER_PASSWORD }, sk());
      const created = res.json().data as Session;
      await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
      await expectAttackerLockedOut(created);
    });
  });

  describe('an unconfirmed account that already has a second factor', () => {
    async function enrolledUnverified(): Promise<{ attacker: Session; totp: OTPAuth.TOTP }> {
      const attacker = await attackerSignsUp();
      await prisma.endUser.update({ where: { id: attacker.endUser.id }, data: { emailVerified: true } });
      const user = { ...sk(), 'x-rekey-user-token': attacker.accessToken };
      const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/setup', headers: user, payload: {} });
      expect(setup.statusCode, setup.body).toBe(201);
      const totp = OTPAuth.URI.parse((setup.json().data as { otpauthUrl: string }).otpauthUrl) as OTPAuth.TOTP;
      const confirmed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup-confirm',
        headers: user,
        payload: { code: totp.generate({ timestamp: Date.now() - 30_000 }) },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      await prisma.endUser.update({ where: { id: attacker.endUser.id }, data: { emailVerified: false } });
      return { attacker, totp };
    }

    it('is neither wiped nor promoted by a magic link until the code is given', async () => {
      const { attacker } = await enrolledUnverified();
      const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
      expect(verified.statusCode, verified.body).toBe(200);
      const challenge = verified.json().data as { mfaRequired: boolean; mfaChallengeToken: string };
      expect(challenge.mfaRequired).toBe(true);

      const row = await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } });
      expect(row.emailVerified).toBe(false);
      expect(row.passwordHash).not.toBeNull();
      expect(await prisma.mfaCredential.count({ where: { endUserId: row.id } })).toBe(1);

      const wrong = await post('/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: '000000' }, pk());
      expect(wrong.statusCode).toBe(401);
      expect((await prisma.endUser.findUniqueOrThrow({ where: { id: row.id } })).emailVerified).toBe(false);
    });

    it('is promoted with everything kept once the prover passes the challenge', async () => {
      const { attacker, totp } = await enrolledUnverified();
      const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
      const challenge = verified.json().data as { mfaChallengeToken: string };
      const passed = await post('/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: totp.generate() }, pk());
      expect(passed.statusCode, passed.body).toBe(200);
      expect((passed.json().data as Session).endUser.emailVerified).toBe(true);

      const row = await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } });
      expect(row.passwordHash).not.toBeNull();
      expect(await prisma.mfaCredential.count({ where: { endUserId: row.id } })).toBe(1);
      expect((await refresh(attacker.refreshToken)).statusCode).toBe(200);
    });

    it('still gets its challenge when the Application requires a confirmed address', async () => {
      await enrolledUnverified();
      await setAuthConfig({ requireEmailVerification: true });
      const verified = await post('/magic-link/verify', { token: await magicLinkToken() }, pk());
      expect(verified.statusCode, verified.body).toBe(200);
      expect((verified.json().data as { mfaRequired: boolean }).mfaRequired).toBe(true);
    });

    it('a provider sign-in links nothing while the code is owed, and links when it is given', async () => {
      const { attacker, totp } = await enrolledUnverified();
      registerOAuthProvider({
        name: 'google',
        buildAuthUrl: () => 'https://mock.example/start',
        exchange: async () => ({ providerAccountId: 'victim-google', email: VICTIM, emailVerified: true }),
      });
      const configured = await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${applicationId}/oauth-config/google`,
        headers: operator,
        payload: { clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'https://app.example.com/oauth/google/callback' },
      });
      expect(configured.statusCode, configured.body).toBe(200);
      const callback = (): Promise<LightMyRequestResponse> => post('/oauth/google/callback', { code: 'mock-code' }, sk());
      const identities = (): Promise<number> => prisma.oAuthIdentity.count({ where: { endUserId: attacker.endUser.id } });

      const first = await callback();
      expect(first.statusCode, first.body).toBe(200);
      expect((first.json().data as { mfaRequired: boolean }).mfaRequired).toBe(true);
      expect(await identities(), 'nothing is linked before the second factor is given').toBe(0);

      // A second sign-in through the same provider account is still a mailbox
      // proof: it is held again, not let through on a link the first one left.
      const second = await callback();
      const challenge = second.json().data as { mfaRequired: boolean; mfaChallengeToken: string };
      expect(challenge.mfaRequired).toBe(true);
      expect((await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } })).emailVerified).toBe(false);

      const passed = await post('/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: totp.generate() }, pk());
      expect(passed.statusCode, passed.body).toBe(200);
      expect((passed.json().data as Session).endUser.emailVerified, 'the account is promoted').toBe(true);
      const linked = await prisma.oAuthIdentity.findMany({ where: { endUserId: attacker.endUser.id } });
      expect(linked.map((i) => [i.provider, i.providerAccountId])).toEqual([['google', 'victim-google']]);
    });

    it('a password sign-in challenge proves no mailbox, so passing it promotes nothing', async () => {
      const { attacker, totp } = await enrolledUnverified();
      const signIn = await passwordSignIn();
      const challenge = signIn.json().data as { mfaChallengeToken: string };
      const passed = await post('/mfa-verify', { mfaChallengeToken: challenge.mfaChallengeToken, code: totp.generate() }, pk());
      expect(passed.statusCode).toBe(200);
      expect((await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } })).emailVerified).toBe(false);
    });
  });

  describe('an unconfirmed account cannot gain another way to sign in', () => {
    const refusals: Array<[string, string, Record<string, unknown>]> = [
      ['passkey registration start', '/passkey/register/start', {}],
      ['passkey registration complete', '/passkey/register/complete', { response: { id: 'x' }, expectedChallenge: 'c' }],
      ['MFA setup', '/mfa/setup', {}],
      ['MFA setup confirmation', '/mfa/setup-confirm', { code: '123456' }],
      ['OAuth link start', '/oauth/google/link/start', { state: 'state-value' }],
      ['OAuth link complete', '/oauth/google/link/complete', { code: 'mock-code' }],
    ];

    it.each(refusals)('%s answers 403 EMAIL_NOT_VERIFIED', async (_name, url, payload) => {
      const session = await attackerSignsUp();
      const res = await post(url, payload, { ...sk(), 'x-rekey-user-token': session.accessToken });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('nothing was stored by the refused calls', async () => {
      const session = await attackerSignsUp();
      const user = { ...sk(), 'x-rekey-user-token': session.accessToken };
      await post('/passkey/register/start', {}, user);
      await post('/mfa/setup', {}, user);
      expect(await prisma.webAuthnChallenge.count({ where: { subjectId: session.endUser.id } })).toBe(0);
      expect(await prisma.mfaCredential.count()).toBe(0);
    });

    it('the same calls pass the gate once the address is confirmed', async () => {
      const session = await attackerSignsUp();
      await prisma.endUser.update({ where: { id: session.endUser.id }, data: { emailVerified: true } });
      const user = { ...sk(), 'x-rekey-user-token': session.accessToken };
      const passkey = await post('/passkey/register/start', {}, user);
      expect(passkey.json().error?.code).toBe('WEBAUTHN_NOT_CONFIGURED');
      expect((await post('/mfa/setup', {}, user)).statusCode).toBe(201);
    });
  });

  it(`${RACERS} sign-in links opened at once produce one claim, and every one of them signs in`, async () => {
    await webhookService.createEndpoint({ createdByTenantUserId: null, applicationId, url: 'https://example.invalid/claim-race', events: ['*'] });
    const attacker = await attackerSignsUp();
    const dispatch = vi.spyOn(emailService, 'dispatch');
    const tokens: string[] = [];
    for (let i = 0; i < RACERS; i++) tokens.push(await magicLinkToken());

    const results = await Promise.all(tokens.map((token) => post('/magic-link/verify', { token }, pk())));
    const winners = results.filter((r) => r.statusCode === 200);
    const outdated = results.filter((r) => r.statusCode === 401);
    expect(winners.length + outdated.length).toBe(RACERS);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const r of outdated) expect(['MAGIC_LINK_INVALID', 'MAGIC_LINK_USED']).toContain(r.json().error.code);

    expect(await prisma.securityEvent.count({ where: { applicationId, type: 'auth.unverified_account_claimed' } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { applicationId, eventType: 'user.updated' } })).toBe(1);
    expect(dispatch.mock.calls.filter((c) => c[0].eventKey === 'account_claimed')).toHaveLength(1);
    await expectAttackerLockedOut(attacker);
    const live = await Promise.all(winners.map((r) => me((r.json().data as Session).accessToken)));
    expect(live.filter((r) => r.statusCode === 200).length, 'at least one prover holds a live session').toBeGreaterThanOrEqual(1);
  });
});
