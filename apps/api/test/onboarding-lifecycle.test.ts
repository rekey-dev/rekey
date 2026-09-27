/**
 * The end-user onboarding lifecycle: which webhooks announce a new or changed
 * account, and when the welcome mail goes out.
 *
 *   - `user.updated` is written in the transaction of the change it announces,
 *     names the changed fields and nothing else, and is not emitted for a write
 *     that changed nothing.
 *   - An operator-created end-user is announced with `user.created`
 *     (`via: "operator"`), atomically with the row.
 *   - OAuth sign-up sends the welcome mail once, and a returning OAuth user
 *     does not get it again.
 *   - Under `requireEmailVerification`, the welcome for an unverified sign-up
 *     waits for the first verification and is sent exactly once.
 *   - `SIGNUP_DISABLED` names ways in that actually work under `invite_only`.
 *
 * Failures are injected with Postgres triggers, as in
 * auth-lifecycle-outbox.test.ts, so the statements that run are production's.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import { emailService } from '../src/modules/email/email.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { issueVerificationToken } from '../src/lib/email-verification.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;

describe('End-user onboarding lifecycle', () => {
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

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ob-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'OB', slug: `ob-${slug}` },
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
      patch: { appUrl: 'https://app.example.com' },
    });
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/onboarding-hook',
      events: ['*'],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS ob_fail_delivery ON webhook_deliveries');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS ob_fail_commit ON end_users');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS ob_raise()');
  });

  async function deliveries(type: string): Promise<Array<Record<string, unknown>>> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: type },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.payload as { data: Record<string, unknown> }).data);
  }

  async function installRaise(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ob_raise() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql`);
  }

  async function failDeliveriesOf(type: string): Promise<void> {
    await installRaise();
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ob_fail_delivery BEFORE INSERT ON webhook_deliveries
      FOR EACH ROW WHEN (NEW.event_type = '${type}') EXECUTE FUNCTION ob_raise()`);
  }

  /**
   * Fail the end-user write at COMMIT, after the event row was written. An
   * event enqueued outside the write's transaction survives this; one written
   * through it does not.
   */
  async function failEndUserCommit(on: 'INSERT' | 'UPDATE', email: string): Promise<void> {
    await installRaise();
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER ob_fail_commit AFTER ${on} ON end_users
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.email = '${email}') EXECUTE FUNCTION ob_raise()`);
  }

  async function signUp(email: string): Promise<{ status: number; userId: string; accessToken?: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email, password: PASSWORD },
    });
    const user = await prisma.endUser.findUnique({
      where: { applicationId_email: { applicationId: appId, email } },
    });
    const data = res.statusCode === 201 ? (res.json().data as { accessToken: string }) : undefined;
    return {
      status: res.statusCode,
      userId: user?.id ?? '',
      ...(data !== undefined && { accessToken: data.accessToken }),
    };
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

  function welcomeSends(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter((c) => (c[0] as { eventKey: string }).eventKey === 'welcome').length;
  }

  function useOAuthIdentity(identity: { id: string; email: string; emailVerified: boolean }): void {
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

  async function oauthCallback(): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: sk(),
      payload: { code: 'mock-code' },
    });
    return res.statusCode;
  }

  async function configureGoogle(): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/oauth-config/google`,
      headers: op(),
      payload: {
        clientId: 'gid',
        clientSecret: 'gsecret',
        redirectUri: 'https://app.example.com/oauth/google/callback',
      },
    });
    expect(res.statusCode).toBe(200);
  }

  // ---------- user.created ----------

  describe('user.created', () => {
    it('password sign-up says so with via: "password"', async () => {
      const r = await signUp('pw@example.com');
      expect(r.status).toBe(201);
      const rows = await deliveries('user.created');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.via).toBe('password');
    });

    it('an operator-created end-user is announced once, with via: "operator"', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: op(),
        payload: { email: 'seeded@example.com', metadata: { plan: 'gold' } },
      });
      expect(res.statusCode).toBe(201);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: res.json().data.id as string } });
      expect(await deliveries('user.created')).toEqual([
        {
          user: {
            id: user.id,
            email: 'seeded@example.com',
            emailVerified: true,
            role: user.role,
            createdAt: user.createdAt.toISOString(),
            metadata: { plan: 'gold' },
          },
          via: 'operator',
        },
      ]);
    });

    it('an operator create whose event cannot be written creates no user', async () => {
      await failDeliveriesOf('user.created');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: op(),
        payload: { email: 'orphan@example.com' },
      });
      expect(res.statusCode).toBe(500);
      expect(await prisma.endUser.count({ where: { applicationId: appId, email: 'orphan@example.com' } })).toBe(0);
    });

    it('an operator create that fails at COMMIT leaves no user.created behind', async () => {
      await failEndUserCommit('INSERT', 'late@example.com');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: op(),
        payload: { email: 'late@example.com' },
      });
      expect(res.statusCode).toBe(500);
      expect(await prisma.endUser.count({ where: { applicationId: appId, email: 'late@example.com' } })).toBe(0);
      expect(await deliveries('user.created')).toHaveLength(0);
    });
  });

  // ---------- user.updated ----------

  describe('user.updated', () => {
    it('a self-service metadata change is announced with the changed field names', async () => {
      const r = await signUp('self@example.com');
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me',
        headers: { ...sk(), 'x-rekey-user-token': r.accessToken! },
        payload: { metadata: { displayName: 'Ada' } },
      });
      expect(res.statusCode).toBe(200);
      const rows = await deliveries('user.updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user: { id: r.userId, email: 'self@example.com', metadata: { displayName: 'Ada' } },
        changed: ['metadata'],
        via: 'self',
      });
    });

    it('a self-service patch that changes nothing announces nothing', async () => {
      const r = await signUp('noop@example.com');
      const headers = { ...sk(), 'x-rekey-user-token': r.accessToken! };
      await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers, payload: { metadata: { a: 1 } } });
      await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers, payload: { metadata: { a: 1 } } });
      await app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers, payload: {} });
      expect(await deliveries('user.updated')).toHaveLength(1);
    });

    it('a self-service change whose event cannot be written is rolled back', async () => {
      const r = await signUp('selfroll@example.com');
      await failDeliveriesOf('user.updated');
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me',
        headers: { ...sk(), 'x-rekey-user-token': r.accessToken! },
        payload: { metadata: { displayName: 'Lost' } },
      });
      expect(res.statusCode).toBe(500);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId } });
      expect(user.metadata).toBeNull();
    });

    it('a self-service change that fails at COMMIT leaves no user.updated behind', async () => {
      const r = await signUp('selflate@example.com');
      await failEndUserCommit('UPDATE', 'selflate@example.com');
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me',
        headers: { ...sk(), 'x-rekey-user-token': r.accessToken! },
        payload: { metadata: { displayName: 'Lost' } },
      });
      expect(res.statusCode).toBe(500);
      expect(await deliveries('user.updated')).toHaveLength(0);
    });

    it('an operator PATCH that fails at COMMIT leaves no user.updated behind', async () => {
      const r = await signUp('oplate@example.com');
      await failEndUserCommit('UPDATE', 'oplate@example.com');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/end-users/${r.userId}`,
        headers: op(),
        payload: { emailVerified: true },
      });
      expect(res.statusCode).toBe(500);
      expect(await deliveries('user.updated')).toHaveLength(0);
    });

    it('a verification that fails at COMMIT leaves no user.updated behind and no welcome', async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { requireEmailVerification: true },
      });
      const r = await signUp('verifylate@example.com');
      await failEndUserCommit('UPDATE', 'verifylate@example.com');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      expect(await verifyWith(r.userId, 'verifylate@example.com')).toBe(500);
      expect(await deliveries('user.updated')).toHaveLength(0);
      expect(welcomeSends(dispatch)).toBe(0);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId } });
      expect(user.welcomeEmailPending).toBe(true);
    });

    it('an operator PATCH names only the fields whose value changed', async () => {
      const r = await signUp('opedit@example.com');
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId } });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/end-users/${r.userId}`,
        headers: op(),
        payload: { role: user.role, emailVerified: true, metadata: { tier: 2 } },
      });
      expect(res.statusCode).toBe(200);
      const rows = await deliveries('user.updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user: { id: r.userId, emailVerified: true, metadata: { tier: 2 } },
        changed: ['emailVerified', 'metadata'],
        via: 'operator',
      });

      // The same PATCH again changes nothing and announces nothing.
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/end-users/${r.userId}`,
        headers: op(),
        payload: { role: user.role, emailVerified: true, metadata: { tier: 2 } },
      });
      expect(await deliveries('user.updated')).toHaveLength(1);
    });

    it('an operator PATCH whose event cannot be written is rolled back', async () => {
      const r = await signUp('oproll@example.com');
      await failDeliveriesOf('user.updated');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/end-users/${r.userId}`,
        headers: op(),
        payload: { emailVerified: true },
      });
      expect(res.statusCode).toBe(500);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId } });
      expect(user.emailVerified).toBe(false);
    });

    it('email verification is announced once, on the false-to-true transition only', async () => {
      const r = await signUp('verify@example.com');
      expect(await verifyWith(r.userId, 'verify@example.com')).toBe(200);
      expect(await verifyWith(r.userId, 'verify@example.com')).toBe(200);
      const rows = await deliveries('user.updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user: { id: r.userId, emailVerified: true },
        changed: ['emailVerified'],
        via: 'email_verification',
      });
    });

    it('a verification whose user.updated cannot be written leaves the address unverified', async () => {
      const r = await signUp('verifyroll@example.com');
      await failDeliveriesOf('user.updated');
      expect(await verifyWith(r.userId, 'verifyroll@example.com')).toBe(500);
      const user = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId } });
      expect(user.emailVerified).toBe(false);
    });

    it('a password change is password.changed, not user.updated', async () => {
      const r = await signUp('pwchange@example.com');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { ...sk(), 'x-rekey-user-token': r.accessToken! },
        payload: { currentPassword: PASSWORD, newPassword: 'another-pw-four-five' },
      });
      expect(res.statusCode).toBe(200);
      expect(await deliveries('password.changed')).toHaveLength(1);
      expect(await deliveries('user.updated')).toHaveLength(0);
    });
  });

  // ---------- Welcome mail ----------

  describe('welcome mail on OAuth sign-up', () => {
    it('is sent once when OAuth creates the user, and not again when they return', async () => {
      await configureGoogle();
      useOAuthIdentity({ id: 'g-1', email: 'oauth@example.com', emailVerified: true });
      const dispatch = vi.spyOn(emailService, 'dispatch');

      expect(await oauthCallback()).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
      const call = dispatch.mock.calls.find((c) => c[0].eventKey === 'welcome')!;
      expect(call[0].to).toBe('oauth@example.com');

      expect(await oauthCallback()).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
    });

    it('is not delivered while the welcome event is switched off', async () => {
      await configureGoogle();
      await prisma.emailEventSetting.create({ data: { applicationId: appId, eventKey: 'welcome', enabled: false } });
      useOAuthIdentity({ id: 'g-off', email: 'oauth-off@example.com', emailVerified: true });
      expect(await oauthCallback()).toBe(200);
      const deadline = Date.now() + 4000;
      let logs: Array<{ status: string }> = [];
      while (logs.length === 0 && Date.now() < deadline) {
        logs = await prisma.emailLog.findMany({ where: { applicationId: appId, eventKey: 'welcome' } });
        if (logs.length === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(logs.map((l) => l.status)).toEqual(['suppressed']);
    });

    it('linking OAuth to an existing account sends no welcome', async () => {
      await signUp('linked@example.com');
      await configureGoogle();
      useOAuthIdentity({ id: 'g-2', email: 'linked@example.com', emailVerified: true });
      const dispatch = vi.spyOn(emailService, 'dispatch');
      expect(await oauthCallback()).toBe(200);
      expect(welcomeSends(dispatch)).toBe(0);
    });
  });

  describe('welcome mail when a verified address is required', () => {
    beforeEach(async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { requireEmailVerification: true },
      });
    });

    it('waits for the first verification, then is sent exactly once', async () => {
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const r = await signUp('deferred@example.com');
      expect(r.status).toBe(403);
      expect(welcomeSends(dispatch)).toBe(0);

      expect(await verifyWith(r.userId, 'deferred@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);

      expect(await verifyWith(r.userId, 'deferred@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
    });

    it(`is sent once when ${RACERS} verification links are opened at the same time`, async () => {
      const r = await signUp('racing@example.com');
      const tokens = await Promise.all(
        Array.from({ length: RACERS }, () =>
          issueVerificationToken({ applicationId: appId, endUserId: r.userId, email: 'racing@example.com' }),
        ),
      );
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const statuses = await Promise.all(
        tokens.map(({ raw }) =>
          app
            .inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: sk(), payload: { token: raw } })
            .then((res) => res.statusCode),
        ),
      );
      expect(statuses.every((s) => s === 200)).toBe(true);
      expect(welcomeSends(dispatch)).toBe(1);
      expect(await deliveries('user.updated')).toHaveLength(1);
    });

    it('an unverified OAuth sign-up gets it on verification, not at creation', async () => {
      await configureGoogle();
      useOAuthIdentity({ id: 'g-3', email: 'oauth-unverified@example.com', emailVerified: false });
      const dispatch = vi.spyOn(emailService, 'dispatch');
      expect(await oauthCallback()).toBe(403);
      expect(welcomeSends(dispatch)).toBe(0);

      const user = await prisma.endUser.findUniqueOrThrow({
        where: { applicationId_email: { applicationId: appId, email: 'oauth-unverified@example.com' } },
      });
      expect(await verifyWith(user.id, 'oauth-unverified@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
    });

    it('a magic link that proves the address counts as the first verification', async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { methods: ['password', 'magic_link'] },
      });
      const r = await signUp('magic@example.com');
      expect(r.status).toBe(403);
      const requested = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: sk(),
        payload: { email: 'magic@example.com' },
      });
      const { magicLinkToken } = requested.json().data as { magicLinkToken: string };
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: sk(),
        payload: { token: magicLinkToken },
      });
      expect(verified.statusCode).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
      const rows = await deliveries('user.updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ changed: ['emailVerified'], via: 'magic_link' });
    });

    it('a user welcomed before the setting was switched on is not welcomed again', async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { requireEmailVerification: false },
      });
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const r = await signUp('early@example.com');
      expect(r.status).toBe(201);
      expect(welcomeSends(dispatch)).toBe(1);

      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { requireEmailVerification: true },
      });
      expect(await verifyWith(r.userId, 'early@example.com')).toBe(200);
      expect(welcomeSends(dispatch)).toBe(1);
    });
  });

  // ---------- invite_only ----------

  describe('SIGNUP_DISABLED', () => {
    it('names ways in that really create a user while sign-up is invite-only', async () => {
      await applicationsService.updateAuthConfig({
        applicationId: appId,
        patch: { signupMode: 'invite_only' },
      });
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: sk(),
        payload: { email: 'blocked@example.com', password: PASSWORD },
      });
      expect(refused.statusCode).toBe(403);
      const { code, fix } = refused.json().error as { code: string; fix: string };
      expect(code).toBe('SIGNUP_DISABLED');
      expect(fix).not.toMatch(/Invite end-user/);
      expect(fix).toContain('End-users page');
      expect(fix).toContain('+ New end-user');
      expect(fix).toContain('POST /api/v1/tenant/applications/:id/end-users');
      expect(fix).toContain('POST /api/v1/users/import');

      const byOperator = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: op(),
        payload: { email: 'blocked@example.com' },
      });
      expect(byOperator.statusCode).toBe(201);
      const byImport = await app.inject({
        method: 'POST',
        url: '/api/v1/users/import',
        headers: sk(),
        payload: { users: [{ email: 'imported@example.com' }] },
      });
      expect(byImport.statusCode).toBe(200);
      expect((byImport.json().data as { created: unknown[] }).created).toHaveLength(1);
    });
  });
});
