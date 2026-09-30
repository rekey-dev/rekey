/**
 * Lifecycle signals an integrator routes on: `session.created` with
 * `firstSignIn`, `isNewUser` on the auth result, the organization invitation
 * events, and the `authConfig.welcomeEmail` timing switch.
 *
 * Every event is asserted as the delivery row the request left behind, and the
 * transactional ones are proven by failing the delivery insert with a Postgres
 * trigger: the write it announces must roll back with it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import { emailService } from '../src/modules/email/email.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { issueVerificationToken } from '../src/lib/email-verification.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;

type Json = Record<string, unknown>;

describe('Lifecycle webhooks and welcome timing', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });
  const sk = (): { authorization: string } => ({ authorization: `Bearer ${secretKey}` });
  const asUser = (token: string): Record<string, string> => ({ ...sk(), 'x-rekey-user-token': token });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `lw-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'LW', slug: `lw-${slug}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await applicationsService.updateAuthConfig({
      applicationId: appId,
      patch: { appUrl: 'https://app.example.com', methods: ['password', 'magic_link'] },
    });
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/lifecycle-hook',
      events: ['*'],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS lw_fail_delivery ON webhook_deliveries');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS lw_fail_commit ON organization_invitations');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS lw_raise()');
  });

  async function deliveries(type: string): Promise<Json[]> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: type },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.payload as { data: Json }).data);
  }

  async function failDeliveriesOf(type: string): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION lw_raise() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER lw_fail_delivery BEFORE INSERT ON webhook_deliveries
      FOR EACH ROW WHEN (NEW.event_type = '${type}') EXECUTE FUNCTION lw_raise()`);
  }

  /**
   * Fail an invitation write at COMMIT, after its event row was written. An
   * event enqueued outside the write's transaction survives this.
   */
  async function failInvitationCommit(on: 'INSERT' | 'UPDATE'): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION lw_raise() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER lw_fail_commit AFTER ${on} ON organization_invitations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION lw_raise()`);
  }

  async function signUp(email: string): Promise<{ status: number; data: Json }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email, password: PASSWORD },
    });
    return { status: res.statusCode, data: (res.json().data ?? {}) as Json };
  }

  async function signIn(email: string): Promise<{ status: number; data: Json }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: sk(),
      payload: { email, password: PASSWORD },
    });
    return { status: res.statusCode, data: (res.json().data ?? {}) as Json };
  }

  async function operatorCreate(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: op(),
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { id: string }).id;
  }

  async function magicLink(email: string): Promise<{ status: number; data: Json }> {
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: sk(),
      payload: { email },
    });
    const { magicLinkToken } = requested.json().data as { magicLinkToken: string };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: sk(),
      payload: { token: magicLinkToken },
    });
    return { status: res.statusCode, data: (res.json().data ?? {}) as Json };
  }

  async function configureGoogle(identity: { id: string; email: string; emailVerified: boolean }): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/oauth-config/google`,
      headers: op(),
      payload: { clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'https://app.example.com/cb' },
    });
    expect(res.statusCode).toBe(200);
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: identity.id,
        email: identity.email,
        emailVerified: identity.emailVerified,
      }),
    });
  }

  async function oauthCallback(): Promise<{ status: number; data: Json }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: sk(),
      payload: { code: 'mock-code' },
    });
    return { status: res.statusCode, data: (res.json().data ?? {}) as Json };
  }

  function welcomeSends(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter((c) => (c[0] as { eventKey: string }).eventKey === 'welcome').length;
  }

  async function verifyWith(userId: string, email: string): Promise<number> {
    const { raw } = await issueVerificationToken({ applicationId: appId, endUserId: userId, email });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: sk(),
      payload: { token: raw },
    });
    return res.statusCode;
  }

  // ---------- session.created and isNewUser ----------

  describe('session.created', () => {
    it('password sign-up is a first sign-in of a new user; the next sign-in is neither', async () => {
      const created = await signUp('pw@example.com');
      expect(created.status).toBe(201);
      expect(created.data.isNewUser).toBe(true);

      const again = await signIn('pw@example.com');
      expect(again.status).toBe(200);
      expect(again.data.isNewUser).toBe(false);

      const user = await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } });
      const rows = await deliveries('session.created');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        userId: user.id,
        sessionId: expect.any(String),
        deviceId: null,
        via: 'password',
        firstSignIn: true,
        platform: 'other',
        country: null,
      });
      expect(rows[1]).toMatchObject({ userId: user.id, via: 'password', firstSignIn: false });
      expect(rows[0]!.sessionId).not.toBe(rows[1]!.sessionId);
      // The session it names is the one the caller holds.
      const head = await prisma.refreshToken.findFirstOrThrow({
        where: { endUserId: user.id, sessionId: rows[0]!.sessionId as string },
      });
      expect(head).toBeTruthy();
    });

    it('a refresh is not a sign-in: no session.created, and isNewUser is false', async () => {
      const created = await signUp('refresh@example.com');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: sk(),
        payload: { refreshToken: created.data.refreshToken },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().data as Json).isNewUser).toBe(false);
      expect(await deliveries('session.created')).toHaveLength(1);
    });

    it(`firstSignIn is true exactly once across ${RACERS} simultaneous first sign-ins`, async () => {
      const userId = await operatorCreate('seeded@example.com');
      const results = await Promise.all(Array.from({ length: RACERS }, () => signIn('seeded@example.com')));
      expect(results.map((r) => r.status)).toEqual(Array(RACERS).fill(200));
      expect(results.every((r) => r.data.isNewUser === false)).toBe(true);

      const rows = await deliveries('session.created');
      expect(rows).toHaveLength(RACERS);
      expect(rows.filter((r) => r.firstSignIn === true)).toHaveLength(1);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: userId } });
      expect(user.firstSignedInAt).not.toBeNull();
    });

    it('a sign-in whose session.created cannot be written mints no session', async () => {
      await signUp('roll@example.com');
      const before = await prisma.refreshToken.count({ where: { applicationId: appId } });
      await failDeliveriesOf('session.created');
      const res = await signIn('roll@example.com');
      expect(res.status).toBe(500);
      expect(await prisma.refreshToken.count({ where: { applicationId: appId } })).toBe(before);
      // Nor did it spend the first sign-in: the next one still reports it.
      const user = await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } });
      expect(user.firstSignedInAt).not.toBeNull();
    });

    it('a failed first sign-in does not spend firstSignIn', async () => {
      await operatorCreate('first-roll@example.com');
      await failDeliveriesOf('session.created');
      expect((await signIn('first-roll@example.com')).status).toBe(500);
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS lw_fail_delivery ON webhook_deliveries');
      expect((await signIn('first-roll@example.com')).status).toBe(200);
      const rows = await deliveries('session.created');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.firstSignIn).toBe(true);
    });

    it('magic link: isNewUser when the link created the user, not when it signed one in', async () => {
      const first = await magicLink('ml@example.com');
      expect(first.status).toBe(200);
      expect(first.data.isNewUser).toBe(true);
      const second = await magicLink('ml@example.com');
      expect(second.data.isNewUser).toBe(false);
      const rows = await deliveries('session.created');
      expect(rows.map((r) => [r.via, r.firstSignIn])).toEqual([
        ['magic_link', true],
        ['magic_link', false],
      ]);
    });

    it('OAuth: isNewUser when the callback created the user, not on return', async () => {
      await configureGoogle({ id: 'g-1', email: 'oauth@example.com', emailVerified: true });
      const first = await oauthCallback();
      expect(first.status).toBe(200);
      expect(first.data.isNewUser).toBe(true);
      const second = await oauthCallback();
      expect(second.data.isNewUser).toBe(false);
      const rows = await deliveries('session.created');
      expect(rows.map((r) => [r.via, r.firstSignIn])).toEqual([
        ['oauth', true],
        ['oauth', false],
      ]);
    });

    it('OAuth linking to an existing password account is not a new user', async () => {
      await signUp('linked@example.com');
      await configureGoogle({ id: 'g-2', email: 'linked@example.com', emailVerified: true });
      const res = await oauthCallback();
      expect(res.status).toBe(200);
      expect(res.data.isNewUser).toBe(false);
    });

    it('an MFA sign-in announces its session when the second factor completes, as via: "mfa"', async () => {
      const created = await signUp('mfa@example.com');
      const token = created.data.accessToken as string;
      const setup = (await app
        .inject({ method: 'POST', url: '/api/v1/auth/mfa/setup', headers: asUser(token) })
        .then((r) => r.json().data)) as { otpauthUrl: string; backupCodes: string[] };
      const secret = new URL(setup.otpauthUrl.replace('otpauth://', 'https://x/')).searchParams.get('secret')!;
      const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup-confirm',
        headers: asUser(token),
        payload: { code },
      });

      const challenge = await signIn('mfa@example.com');
      expect(challenge.data.mfaRequired).toBe(true);
      expect(await deliveries('session.created')).toHaveLength(1);

      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa-verify',
        headers: sk(),
        payload: { mfaChallengeToken: challenge.data.mfaChallengeToken, code: setup.backupCodes[0] },
      });
      expect(verified.statusCode).toBe(200);
      expect((verified.json().data as Json).isNewUser).toBe(false);
      const rows = await deliveries('session.created');
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ via: 'mfa', firstSignIn: false });
    });

    it('switching the active organization re-mints a session and announces nothing', async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { organizationsEnabled: true },
      });
      const created = await signUp('switcher@example.com');
      const token = created.data.accessToken as string;
      const org = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations',
        headers: asUser(token),
        payload: { name: 'Switch', slug: 'switch-org' },
      });
      const orgId = (org.json().data as { organization: { id: string } }).organization.id;
      const switched = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${orgId}/switch`,
        headers: asUser(token),
      });
      expect(switched.statusCode).toBe(200);
      expect((switched.json().data as Json).isNewUser).toBe(false);
      expect(await deliveries('session.created')).toHaveLength(1);
    });

    it('a sign-up refused a session by requireEmailVerification announces no session', async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { requireEmailVerification: true },
      });
      expect((await signUp('gated@example.com')).status).toBe(403);
      expect(await deliveries('session.created')).toHaveLength(0);
      const user = await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } });
      expect(user.firstSignedInAt).toBeNull();
    });
  });

  // ---------- Organization invitations ----------

  describe('organization invitations', () => {
    async function orgWithInvite(inviteeEmail: string): Promise<{ orgId: string; token: string; ownerId: string }> {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { organizationsEnabled: true },
      });
      const owner = await signUp('owner@example.com');
      const ownerToken = owner.data.accessToken as string;
      const org = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations',
        headers: asUser(ownerToken),
        payload: { name: 'Acme', slug: `acme-${Math.random().toString(36).slice(2, 6)}` },
      });
      expect(org.statusCode).toBe(201);
      const orgId = (org.json().data as { organization: { id: string } }).organization.id;
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${orgId}/invitations`,
        headers: asUser(ownerToken),
        payload: { email: inviteeEmail },
      });
      expect(invite.statusCode).toBe(201);
      return {
        orgId,
        token: (invite.json().data as { token: string }).token,
        ownerId: (owner.data.endUser as { id: string }).id,
      };
    }

    it('invitation.created carries the invitation and never the token', async () => {
      const { orgId, token, ownerId } = await orgWithInvite('Invitee@Example.com');
      const rows = await deliveries('organization.invitation.created');
      expect(rows).toHaveLength(1);
      const invitation = await prisma.organizationInvitation.findFirstOrThrow({ where: { organizationId: orgId } });
      expect(rows[0]).toEqual({
        invitation: {
          id: invitation.id,
          organizationId: orgId,
          email: 'invitee@example.com',
          role: invitation.role,
          invitedById: ownerId,
          expiresAt: invitation.expiresAt.toISOString(),
          createdAt: invitation.createdAt.toISOString(),
        },
      });
      const raw = await prisma.webhookDelivery.findFirstOrThrow({
        where: { applicationId: appId, eventType: 'organization.invitation.created' },
      });
      expect(JSON.stringify(raw.payload)).not.toContain(token);
      expect(JSON.stringify(raw.payload)).not.toContain(invitation.tokenHash);
    });

    it('an invitation whose event cannot be written is not created', async () => {
      await failDeliveriesOf('organization.invitation.created');
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { organizationsEnabled: true },
      });
      const owner = await signUp('owner2@example.com');
      const org = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations',
        headers: asUser(owner.data.accessToken as string),
        payload: { name: 'Beta', slug: 'beta-org' },
      });
      const orgId = (org.json().data as { organization: { id: string } }).organization.id;
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${orgId}/invitations`,
        headers: asUser(owner.data.accessToken as string),
        payload: { email: 'lost@example.com' },
      });
      expect(invite.statusCode).toBe(500);
      expect(await prisma.organizationInvitation.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('an invitation that fails at COMMIT leaves no invitation.created behind', async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { organizationsEnabled: true },
      });
      const owner = await signUp('owner3@example.com');
      const org = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations',
        headers: asUser(owner.data.accessToken as string),
        payload: { name: 'Gamma', slug: 'gamma-org' },
      });
      const orgId = (org.json().data as { organization: { id: string } }).organization.id;
      await failInvitationCommit('INSERT');
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${orgId}/invitations`,
        headers: asUser(owner.data.accessToken as string),
        payload: { email: 'late-commit@example.com' },
      });
      expect(invite.statusCode).toBe(500);
      expect(await deliveries('organization.invitation.created')).toHaveLength(0);
    });

    it('an accept that fails at COMMIT leaves no invitation.accepted behind', async () => {
      const { token } = await orgWithInvite('late-accept@example.com');
      const joiner = await signUp('late-accept@example.com');
      await failInvitationCommit('UPDATE');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: asUser(joiner.data.accessToken as string),
        payload: { token },
      });
      expect(res.statusCode).toBe(500);
      expect(await deliveries('organization.invitation.accepted')).toHaveLength(0);
    });

    it(`invitation.accepted is announced once, however many of ${RACERS} accepts race`, async () => {
      const { orgId, token } = await orgWithInvite('joiner@example.com');
      const joiner = await signUp('joiner@example.com');
      const joinerToken = joiner.data.accessToken as string;
      const statuses = await Promise.all(
        Array.from({ length: RACERS }, () =>
          app
            .inject({
              method: 'POST',
              url: '/api/v1/auth/organizations/accept-invitation',
              headers: asUser(joinerToken),
              payload: { token },
            })
            .then((r) => r.statusCode),
        ),
      );
      expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
      const rows = await deliveries('organization.invitation.accepted');
      expect(rows).toHaveLength(1);
      const invitation = await prisma.organizationInvitation.findFirstOrThrow({ where: { organizationId: orgId } });
      const membership = await prisma.organizationMembership.findFirstOrThrow({
        where: { organizationId: orgId, endUserId: (joiner.data.endUser as { id: string }).id },
      });
      expect(rows[0]).toEqual({
        invitation: {
          id: invitation.id,
          organizationId: orgId,
          email: 'joiner@example.com',
          role: invitation.role,
          acceptedAt: invitation.acceptedAt!.toISOString(),
        },
        membership: {
          id: membership.id,
          organizationId: orgId,
          endUserId: membership.endUserId,
          role: membership.role,
        },
      });
    });

    it('an accept whose event cannot be written leaves the invitation open and no membership', async () => {
      const { orgId, token } = await orgWithInvite('late@example.com');
      const joiner = await signUp('late@example.com');
      await failDeliveriesOf('organization.invitation.accepted');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: asUser(joiner.data.accessToken as string),
        payload: { token },
      });
      expect(res.statusCode).toBe(500);
      const invitation = await prisma.organizationInvitation.findFirstOrThrow({ where: { organizationId: orgId } });
      expect(invitation.acceptedAt).toBeNull();
      expect(
        await prisma.organizationMembership.count({
          where: { organizationId: orgId, endUserId: (joiner.data.endUser as { id: string }).id },
        }),
      ).toBe(0);
    });
  });

  // ---------- welcomeEmail ----------

  describe('authConfig.welcomeEmail', () => {
    const setWelcome = (welcomeEmail: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/auth-config`,
        headers: op(),
        payload: { welcomeEmail },
      });

    it('defaults to on_signup and round-trips through the auth-config PATCH', async () => {
      const app0 = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      expect((app0.authConfig as { welcomeEmail?: string }).welcomeEmail ?? 'on_signup').toBe('on_signup');
      const res = await setWelcome('on_verified');
      expect(res.statusCode).toBe(200);
      expect((res.json().data.authConfig as { welcomeEmail: string }).welcomeEmail).toBe('on_verified');
      expect((await setWelcome('sometimes')).statusCode).toBe(400);
    });

    it('off: no welcome on any sign-up, and none on verification', async () => {
      expect((await setWelcome('off')).statusCode).toBe(200);
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const created = await signUp('off@example.com');
      await magicLink('off-ml@example.com');
      await configureGoogle({ id: 'g-off', email: 'off-oauth@example.com', emailVerified: true });
      await oauthCallback();
      const userId = (created.data.endUser as { id: string }).id;
      expect(await verifyWith(userId, 'off@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(0);
      expect(await prisma.endUser.count({ where: { applicationId: appId, welcomeEmailPending: true } })).toBe(0);
    });

    it('on_verified: an unverified sign-up is welcomed on verification, even with sessions allowed', async () => {
      await setWelcome('on_verified');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const created = await signUp('later@example.com');
      expect(created.status).toBe(201);
      expect(welcomeSends(dispatch)).toBe(0);
      const userId = (created.data.endUser as { id: string }).id;
      expect(await verifyWith(userId, 'later@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
      expect(await verifyWith(userId, 'later@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
    });

    it('on_verified: an address verified at creation is welcomed straight away', async () => {
      await setWelcome('on_verified');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      await magicLink('instant@example.com');
      expect(welcomeSends(dispatch)).toBe(1);
      await configureGoogle({ id: 'g-v', email: 'instant-oauth@example.com', emailVerified: true });
      await oauthCallback();
      expect(welcomeSends(dispatch)).toBe(2);
    });

    it('on_signup: with sessions allowed, the welcome goes at sign-up', async () => {
      const dispatch = vi.spyOn(emailService, 'dispatch');
      await signUp('now@example.com');
      expect(welcomeSends(dispatch)).toBe(1);
    });

    it('switched off while a welcome is pending: verification sends nothing and clears it', async () => {
      await setWelcome('on_verified');
      const created = await signUp('pending@example.com');
      await setWelcome('off');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const userId = (created.data.endUser as { id: string }).id;
      expect(await verifyWith(userId, 'pending@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(0);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: userId } });
      expect(user.welcomeEmailPending).toBe(false);
    });
  });
});
