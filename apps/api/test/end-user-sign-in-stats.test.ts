/**
 * Sign-in counters on the end user: `lastSignedInAt`, `lastSignInVia` and
 * `signInCount`. Written only by a real sign-in (the credential branch of
 * `issuePair`), never by refresh or an organization switch, and rolled back
 * with the sign-in they count.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;

type Json = Record<string, unknown>;

describe('End-user sign-in counters', () => {
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
  afterEach(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS sis_fail_delivery ON webhook_deliveries');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS sis_raise()');
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
        payload: { email: `sis-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'SIS', slug: `sis-${slug}` },
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
      patch: { methods: ['password', 'magic_link'] },
    });
  });

  async function signUp(email: string): Promise<Json> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data as Json;
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

  async function stats(email: string) {
    return prisma.endUser.findFirstOrThrow({
      where: { applicationId: appId, email },
      select: { id: true, lastSignedInAt: true, lastSignInVia: true, signInCount: true, updatedAt: true },
    });
  }

  it('an operator-created user has never signed in', async () => {
    await operatorCreate('fresh@example.com');
    expect(await stats('fresh@example.com')).toMatchObject({
      lastSignedInAt: null,
      lastSignInVia: null,
      signInCount: 0,
    });
  });

  it('sign-up and each sign-in count once, with the method and time', async () => {
    const before = Date.now();
    await signUp('count@example.com');
    expect(await stats('count@example.com')).toMatchObject({ signInCount: 1, lastSignInVia: 'password' });
    expect((await signIn('count@example.com')).status).toBe(200);
    const after = await stats('count@example.com');
    expect(after.signInCount).toBe(2);
    expect(after.lastSignedInAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(after.lastSignedInAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a sign-in leaves updatedAt alone, since OIDC reads it as "profile changed"', async () => {
    await signUp('stamp@example.com');
    const first = await stats('stamp@example.com');
    await signIn('stamp@example.com');
    const second = await stats('stamp@example.com');
    expect(second.signInCount).toBe(2);
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it('a magic-link sign-in records via "magic_link"', async () => {
    await operatorCreate('ml@example.com');
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: sk(),
      payload: { email: 'ml@example.com' },
    });
    const { magicLinkToken } = requested.json().data as { magicLinkToken: string };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: sk(),
      payload: { token: magicLinkToken },
    });
    expect(res.statusCode).toBe(200);
    expect(await stats('ml@example.com')).toMatchObject({ signInCount: 1, lastSignInVia: 'magic_link' });
  });

  it('refresh does not count as a sign-in', async () => {
    const created = await signUp('refresh@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: sk(),
      payload: { refreshToken: created.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    expect((await stats('refresh@example.com')).signInCount).toBe(1);
  });

  it('switching the active organization does not count as a sign-in', async () => {
    await applicationsService.updateAuthConfig({ applicationId: appId, patch: { organizationsEnabled: true } });
    const created = await signUp('switch@example.com');
    const token = created.accessToken as string;
    const org = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations',
      headers: asUser(token),
      payload: { name: 'Switch', slug: `switch-${appId.slice(-6)}` },
    });
    const orgId = (org.json().data as { organization: { id: string } }).organization.id;
    const switched = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${orgId}/switch`,
      headers: asUser(token),
    });
    expect(switched.statusCode).toBe(200);
    expect((await stats('switch@example.com')).signInCount).toBe(1);
  });

  it('an MFA sign-in counts once, when the second factor completes, as via "mfa"', async () => {
    const created = await signUp('mfa@example.com');
    const token = created.accessToken as string;
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
    expect((await stats('mfa@example.com')).signInCount).toBe(1);

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa-verify',
      headers: sk(),
      payload: { mfaChallengeToken: challenge.data.mfaChallengeToken, code: setup.backupCodes[0] },
    });
    expect(verified.statusCode).toBe(200);
    expect(await stats('mfa@example.com')).toMatchObject({ signInCount: 2, lastSignInVia: 'mfa' });
  });

  it(`${RACERS} simultaneous sign-ins each count exactly once`, async () => {
    const id = await operatorCreate('race@example.com');
    // Claimed up front: the first-sign-in claim locks the row for its whole
    // transaction, which would serialize the racers and hide a lost update.
    await prisma.endUser.update({ where: { id }, data: { firstSignedInAt: new Date() } });
    const results = await Promise.all(Array.from({ length: RACERS }, () => signIn('race@example.com')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await stats('race@example.com')).signInCount).toBe(RACERS);
  });

  it('a sign-in that rolls back counts nothing', async () => {
    await operatorCreate('rollback@example.com');
    await prisma.webhookEndpoint.create({
      data: { applicationId: appId, url: 'https://example.invalid/hook', secret: 'whsec_x', events: ['*'] },
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION sis_raise() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER sis_fail_delivery BEFORE INSERT ON webhook_deliveries
      FOR EACH ROW WHEN (NEW.event_type = 'session.created') EXECUTE FUNCTION sis_raise()`);
    expect((await signIn('rollback@example.com')).status).toBe(500);
    expect(await stats('rollback@example.com')).toMatchObject({ signInCount: 0, lastSignedInAt: null });
  });

  it('GET /users/:id carries the counters', async () => {
    await signUp('dto@example.com');
    const { id } = await stats('dto@example.com');
    const res = await app.inject({ method: 'GET', url: `/api/v1/users/${id}`, headers: sk() });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Json;
    expect(data).toMatchObject({ signInCount: 1, lastSignInVia: 'password' });
    expect(typeof data.lastSignedInAt).toBe('string');
  });

  describe('operator list', () => {
    async function listEmails(query: string): Promise<{ email: string; lastSignedInAt: string | null }[]> {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appId}/end-users?${query}`,
        headers: op(),
      });
      expect(res.statusCode).toBe(200);
      return (res.json().data as { items: { email: string; lastSignedInAt: string | null }[] }).items;
    }

    beforeEach(async () => {
      await operatorCreate('never@example.com');
      await operatorCreate('old@example.com');
      await operatorCreate('recent@example.com');
      await prisma.endUser.updateMany({
        where: { applicationId: appId, email: 'old@example.com' },
        data: { lastSignedInAt: new Date('2026-01-01T00:00:00Z') },
      });
      await prisma.endUser.updateMany({
        where: { applicationId: appId, email: 'recent@example.com' },
        data: { lastSignedInAt: new Date('2026-09-01T00:00:00Z') },
      });
    });

    it('returns lastSignedInAt on every row, null for a user who never signed in', async () => {
      const rows = await listEmails('');
      expect(rows.find((r) => r.email === 'never@example.com')?.lastSignedInAt).toBeNull();
      expect(rows.find((r) => r.email === 'recent@example.com')?.lastSignedInAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('sorts by lastSignedInAt with never-signed-in users last in both directions', async () => {
      expect((await listEmails('sort=lastSignedInAt&order=desc')).map((r) => r.email)).toEqual([
        'recent@example.com',
        'old@example.com',
        'never@example.com',
      ]);
      expect((await listEmails('sort=lastSignedInAt&order=asc')).map((r) => r.email)).toEqual([
        'old@example.com',
        'recent@example.com',
        'never@example.com',
      ]);
    });
  });
});
