/**
 * Portal sessions on a device-bound Application.
 *
 * With `authConfig.deviceBinding = 'required'`, the hosted portal signs a user
 * in without a device. It proves itself with INTERNAL_CALLER_SECRET, and gets
 * an `eu_portal` access token and a `portal` refresh row that hold no device
 * slot. Those are honoured only on a request that carries the caller secret.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import * as OTPAuth from 'otpauth';

// No browser to sign a WebAuthn assertion, so the verifier is stubbed as in
// end-user-passkeys.test.ts.
vi.mock('@simplewebauthn/server', async () => {
  const actual = await vi.importActual<typeof import('@simplewebauthn/server')>('@simplewebauthn/server');
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(async () => ({ verified: true, authenticationInfo: { newCounter: 1 } })),
  };
});

import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { getActiveSigningKey } from '../src/lib/signing-keys.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { makeEndUser as makeEndUserFor, setDefaultDeviceLimit as setDefaultDeviceLimitFor } from './device-fixtures.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';
const CALLER_SECRET = 'caller-secret-for-portal-session-tests';
const PORTAL = { 'x-rekey-caller-secret': CALLER_SECRET };
// The portal origin the API auto-allows, derived the way portal.test.ts does.
const PORTAL_ORIGIN = new URL(process.env.PUBLIC_PORTAL_URL ?? 'https://portal.test.invalid').origin;

type Session = { accessToken: string; refreshToken: string; deviceId: string | null; endUser: { id: string } };

describe('portal sessions on a device-bound application', () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let appId: string;
  let liveKey: string;
  // Set by the publishable-key block: calls then carry what the real portal
  // sends, the publishable key and its Origin.
  let publishable: { key: string; origin: string } | null = null;

  beforeAll(async () => {
    app = await buildApp({ logger: false, apiProxy: { callerSecret: CALLER_SECRET } });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const opAuth = () => ({ authorization: `Bearer ${operatorToken}` });
  const keyAuth = (): Record<string, string> =>
    publishable
      ? { authorization: `Bearer ${publishable.key}`, origin: publishable.origin }
      : { authorization: `Bearer ${liveKey}` };

  beforeEach(async () => {
    publishable = null;
    const slug = Math.random().toString(36).slice(2, 8);
    operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ps-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: opAuth(),
        payload: { name: 'PS', slug: `ps-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: opAuth(),
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await setAuthConfig({ deviceBinding: 'required' });
  });

  async function setAuthConfig(patch: Record<string, unknown>): Promise<void> {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: { authConfig: { ...(application.authConfig as object), ...patch } as never },
    });
  }

  const makeEndUser = (email: string) => makeEndUserFor(app, operatorToken, appId, email, PASSWORD);
  const typ = (token: string) => (jwt.decode(token) as Record<string, unknown>).typ;
  const headRow = (accessToken: string) =>
    prisma.refreshToken.findFirstOrThrow({
      where: { sessionId: (jwt.decode(accessToken) as { sid: string }).sid, revokedAt: null },
    });

  function signIn(email: string, extra: { portal?: boolean; fingerprint?: string } = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { ...keyAuth(), ...(extra.portal && PORTAL) },
      payload: { email, password: PASSWORD, ...(extra.fingerprint && { device: { fingerprint: extra.fingerprint } }) },
    });
  }
  async function portalSignIn(email: string): Promise<Session> {
    const res = await signIn(email, { portal: true });
    expect(res.statusCode).toBe(200);
    return res.json().data as Session;
  }
  const refresh = (refreshToken: string, portal: boolean) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { ...keyAuth(), ...(portal && PORTAL) },
      payload: { refreshToken },
    });
  const usersMe = (accessToken: string, portal: boolean) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { ...keyAuth(), 'x-rekey-user-token': accessToken, ...(portal && PORTAL) },
    });
  const authMe = (accessToken: string, portal: boolean) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { 'x-rekey-user-token': accessToken, ...(portal && PORTAL) },
    });

  it('signs the portal in without a device: eu_portal token, portal row, no device', async () => {
    const userId = await makeEndUser('a@example.com');
    const s = await portalSignIn('a@example.com');
    expect(s.deviceId).toBeNull();
    expect(typ(s.accessToken)).toBe('eu_portal');
    expect((jwt.decode(s.accessToken) as Record<string, unknown>).dev).toBeUndefined();
    const row = await headRow(s.accessToken);
    expect(row.kind).toBe('portal');
    expect(row.deviceId).toBeNull();
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
  });

  it('holds no device slot and is issued when the account is already at its device limit', async () => {
    await setDefaultDeviceLimitFor(app, operatorToken, appId, 1);
    const userId = await makeEndUser('limit@example.com');
    expect((await signIn('limit@example.com', { fingerprint: 'fp-limit-laptop-01' })).statusCode).toBe(200);

    const s = await portalSignIn('limit@example.com');
    expect(typ(s.accessToken)).toBe('eu_portal');
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);

    // The one slot is still the laptop's: a second machine is refused, not a third.
    const second = await signIn('limit@example.com', { fingerprint: 'fp-limit-desktop-1' });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('DEVICE_LIMIT_REACHED');
    expect((second.json().error.details as { devices: unknown[] }).devices).toHaveLength(1);
  });

  it('still refuses a sign-in without a device and without the caller secret', async () => {
    await makeEndUser('bare@example.com');
    const res = await signIn('bare@example.com');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');
    expect(res.json().error.fix).toContain('INTERNAL_CALLER_SECRET');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { ...keyAuth(), 'x-rekey-caller-secret': 'not-the-secret' },
      payload: { email: 'bare@example.com', password: PASSWORD },
    });
    expect(wrong.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');
  });

  it('a portal access token works only with the caller secret, on a session route and on GET /auth/me', async () => {
    await makeEndUser('me@example.com');
    const s = await portalSignIn('me@example.com');

    const refused = await usersMe(s.accessToken, false);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('USER_TOKEN_INVALID');
    expect((await usersMe(s.accessToken, true)).statusCode).toBe(200);

    const meRefused = await authMe(s.accessToken, false);
    expect(meRefused.statusCode).toBe(401);
    expect(meRefused.json().error.code).toBe('USER_TOKEN_INVALID');
    expect((await authMe(s.accessToken, true)).statusCode).toBe(200);
  });

  it('a portal refresh token refreshes only with the caller secret, and stays a portal session', async () => {
    await makeEndUser('rf@example.com');
    const s = await portalSignIn('rf@example.com');

    const refused = await refresh(s.refreshToken, false);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('REFRESH_TOKEN_INVALID');

    const res = await refresh(s.refreshToken, true);
    expect(res.statusCode).toBe(200);
    const rotated = res.json().data as Session;
    expect(typ(rotated.accessToken)).toBe('eu_portal');
    expect(rotated.deviceId).toBeNull();
    expect((await headRow(rotated.accessToken)).kind).toBe('portal');
  });

  it('a portal chain binds no device at refresh, even when the request names one', async () => {
    const userId = await makeEndUser('rfdev@example.com');
    const s = await portalSignIn('rfdev@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { ...keyAuth(), ...PORTAL },
      payload: { refreshToken: s.refreshToken, device: { fingerprint: 'fp-portal-refresh1' } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as Session).deviceId).toBeNull();
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
  });

  it('a spent portal refresh token replayed without the caller secret is reuse, even inside the race window', async () => {
    const userId = await makeEndUser('replay@example.com');
    const s = await portalSignIn('replay@example.com');
    expect((await refresh(s.refreshToken, true)).statusCode).toBe(200);
    const replay = await refresh(s.refreshToken, false);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(0);
    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { actorId: userId, type: 'user.refresh_token_reused' },
    });
    expect((event.metadata as Record<string, unknown>).reason).toBe('portal_without_caller_secret');
  });

  it('the portal racing itself inside the reuse window is answered as a race and revokes nothing', async () => {
    const userId = await makeEndUser('race@example.com');
    const s = await portalSignIn('race@example.com');
    const first = await refresh(s.refreshToken, true);
    expect(first.statusCode).toBe(200);
    const second = await refresh(s.refreshToken, true);
    expect(second.json().error.code).toBe('REFRESH_TOKEN_RACED');
    const live = await prisma.refreshToken.findMany({ where: { endUserId: userId, revokedAt: null } });
    expect(live.map((t) => t.kind)).toEqual(['portal']);
    expect((await usersMe((first.json().data as Session).accessToken, true)).statusCode).toBe(200);
  });

  it('a normal refresh token presented with the caller secret stays a normal session', async () => {
    await makeEndUser('norm@example.com');
    const s = (await signIn('norm@example.com', { fingerprint: 'fp-normal-laptop1' })).json().data as Session;
    const res = await refresh(s.refreshToken, true);
    expect(res.statusCode).toBe(200);
    const rotated = res.json().data as Session;
    expect(typ(rotated.accessToken)).toBe('eu_access');
    expect(rotated.deviceId).toBe(s.deviceId);
    expect((await headRow(rotated.accessToken)).kind).toBe('session');
  });

  it('an organization switch keeps a portal session a portal session', async () => {
    await setAuthConfig({ organizationsEnabled: true });
    const userId = await makeEndUser('org@example.com');
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: opAuth(),
        payload: { name: 'team', slug: 'team', ownerEndUserId: userId },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const s = await portalSignIn('org@example.com');

    const switched = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${orgId}/switch`,
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken, ...PORTAL },
    });
    expect(switched.statusCode).toBe(200);
    const next = switched.json().data as Session;
    expect(typ(next.accessToken)).toBe('eu_portal');
    expect((jwt.decode(next.accessToken) as Record<string, unknown>).oid).toBe(orgId);
    expect((await headRow(next.accessToken)).kind).toBe('portal');

    const cleared = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations/clear-active-organization',
      headers: { ...keyAuth(), 'x-rekey-user-token': next.accessToken, ...PORTAL },
    });
    expect(cleared.statusCode).toBe(200);
    expect(typ((cleared.json().data as Session).accessToken)).toBe('eu_portal');
  });

  it('MFA verify through the portal issues a portal session', async () => {
    await setAuthConfig({ deviceBinding: 'optional' });
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: keyAuth(),
        payload: { email: 'mfa@example.com', password: PASSWORD, emailVerified: true },
      })
      .then((r) => r.json().data as { accessToken: string });
    const setup = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: { ...keyAuth(), 'x-rekey-user-token': eu.accessToken },
      })
      .then((r) => r.json().data as { otpauthUrl: string; backupCodes: string[] });
    const totp = OTPAuth.URI.parse(setup.otpauthUrl) as OTPAuth.TOTP;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/mfa/setup-confirm',
          headers: { ...keyAuth(), 'x-rekey-user-token': eu.accessToken },
          payload: { code: totp.generate() },
        })
      ).statusCode,
    ).toBe(200);
    await setAuthConfig({ deviceBinding: 'required' });

    const challenge = (await signIn('mfa@example.com', { portal: true })).json().data as { mfaChallengeToken: string };
    const verify = (portal: boolean) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa-verify',
        headers: { ...keyAuth(), ...(portal && PORTAL) },
        payload: { mfaChallengeToken: challenge.mfaChallengeToken, code: setup.backupCodes[0] },
      });
    const bare = await verify(false);
    expect(bare.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');

    const res = await verify(true);
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(typ(s.accessToken)).toBe('eu_portal');
    expect((await headRow(s.accessToken)).kind).toBe('portal');
  });

  it('magic-link verify through the portal issues a portal session', async () => {
    await setAuthConfig({ methods: ['password', 'magic_link'] });
    await makeEndUser('ml@example.com');
    const link = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: keyAuth(),
        payload: { email: 'ml@example.com' },
      })
      .then((r) => r.json().data as { magicLinkToken: string });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { ...keyAuth(), ...PORTAL },
      payload: { token: link.magicLinkToken },
    });
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(typ(s.accessToken)).toBe('eu_portal');
    expect((await headRow(s.accessToken)).kind).toBe('portal');
  });

  it('an OAuth callback through the portal issues a portal session', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/oauth-config/google`,
      headers: opAuth(),
      payload: { clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'https://app.example/oauth/google/callback' },
    });
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({ providerAccountId: 'g-portal', email: 'oauth-portal@example.com', emailVerified: true }),
    });
    const callback = (portal: boolean) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth/google/callback',
        headers: { ...keyAuth(), ...(portal && PORTAL) },
        payload: { code: 'mock-code' },
      });
    expect((await callback(false)).json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');
    const res = await callback(true);
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(typ(s.accessToken)).toBe('eu_portal');
    expect((await headRow(s.accessToken)).kind).toBe('portal');
  });

  it('gives the portal an ordinary session when the binding is optional', async () => {
    await setAuthConfig({ deviceBinding: 'optional' });
    await makeEndUser('opt@example.com');
    const s = await portalSignIn('opt@example.com');
    expect(typ(s.accessToken)).toBe('eu_access');
    expect((await headRow(s.accessToken)).kind).toBe('session');
  });

  it("releasing a device from a portal session revokes that device's sessions and keeps the portal session", async () => {
    const userId = await makeEndUser('rel@example.com');
    const laptop = (await signIn('rel@example.com', { fingerprint: 'fp-release-laptop' })).json().data as Session;
    const s = await portalSignIn('rel@example.com');
    await new Promise((r) => setTimeout(r, 1_100));

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/devices',
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken, ...PORTAL },
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json().data)).toContain(laptop.deviceId!);

    const released = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/me/devices/${laptop.deviceId}`,
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken, ...PORTAL },
    });
    expect(released.statusCode).toBe(200);

    expect((await usersMe(laptop.accessToken, false)).statusCode).toBe(401);
    expect((await refresh(laptop.refreshToken, false)).json().error.code).toBe('REFRESH_TOKEN_REVOKED');
    expect((await usersMe(s.accessToken, true)).statusCode).toBe(200);
    expect((await refresh(s.refreshToken, true)).statusCode).toBe(200);
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, kind: 'portal', revokedAt: null } })).toBe(1);
  });

  it('marks the portal session as current to the portal, and the device session as current to the device', async () => {
    await makeEndUser('mine@example.com');
    const laptop = (await signIn('mine@example.com', { fingerprint: 'fp-current-laptop-1' })).json().data as Session;
    const s = await portalSignIn('mine@example.com');
    const currentIds = async (accessToken: string, portal: boolean) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/sessions',
        headers: { ...keyAuth(), 'x-rekey-user-token': accessToken, ...(portal && PORTAL) },
      });
      expect(res.statusCode).toBe(200);
      const items = (res.json().data as { items: Array<{ id: string; current: boolean }> }).items;
      expect(items).toHaveLength(2);
      return items.filter((i) => i.current).map((i) => i.id);
    };
    expect(await currentIds(s.accessToken, true)).toEqual([(await headRow(s.accessToken)).id]);
    expect(await currentIds(laptop.accessToken, false)).toEqual([(await headRow(laptop.accessToken)).id]);
  });

  it('sign-out everywhere ends portal sessions too', async () => {
    const userId = await makeEndUser('out@example.com');
    const s = await portalSignIn('out@example.com');
    const sessions = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken, ...PORTAL },
    });
    expect(sessions.statusCode).toBe(200);
    expect(JSON.stringify(sessions.json().data)).toContain((await headRow(s.accessToken)).id);

    await new Promise((r) => setTimeout(r, 1_100));
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out-everywhere',
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken, ...PORTAL },
    });
    expect(out.statusCode).toBe(200);
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(0);
    expect((await usersMe(s.accessToken, true)).statusCode).toBe(401);
  });

  it('sign-up through the portal on a binding-required app issues a portal session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { ...keyAuth(), ...PORTAL },
      payload: { email: 'new@example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json().data as Session;
    expect(typ(s.accessToken)).toBe('eu_portal');
    expect((await headRow(s.accessToken)).kind).toBe('portal');
    expect(await prisma.device.count({ where: { endUserId: s.endUser.id } })).toBe(0);
  });

  it('passkey sign-in through the portal on a binding-required app issues a portal session', async () => {
    await setAuthConfig({
      methods: ['password', 'passkey'],
      webauthn: { rpId: 'localhost', rpOrigins: ['http://localhost:3030'], rpName: 'Rekey Test' },
    });
    const userId = await makeEndUser('pk@example.com');
    await prisma.webAuthnCredential.create({
      data: {
        applicationId: appId,
        endUserId: userId,
        credentialId: `pk-${appId}`,
        publicKey: 'AQID',
        counter: BigInt(0),
        transports: ['internal'],
      },
    });
    const complete = async (portal: boolean) => {
      const start = await app
        .inject({ method: 'POST', url: '/api/v1/auth/passkey/authenticate/start', headers: keyAuth(), payload: {} })
        .then((r) => r.json().data as { expectedChallenge: string });
      return app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/authenticate/complete',
        headers: { ...keyAuth(), ...(portal && PORTAL) },
        payload: { response: { id: `pk-${appId}` }, expectedChallenge: start.expectedChallenge },
      });
    };
    expect((await complete(false)).json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');
    const res = await complete(true);
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(typ(s.accessToken)).toBe('eu_portal');
    expect((await headRow(s.accessToken)).kind).toBe('portal');
  });

  describe('on an RS256 application', () => {
    beforeEach(async () => {
      await setAuthConfig({ tokenAlg: 'RS256' });
    });

    const header = (token: string) => (jwt.decode(token, { complete: true }) as { header: { alg: string } }).header;

    it('signs the portal token HS256 with the application secret, never with the JWKS key', async () => {
      await makeEndUser('rs@example.com');
      const laptop = (await signIn('rs@example.com', { fingerprint: 'fp-rs256-laptop1' })).json().data as Session;
      expect(header(laptop.accessToken).alg).toBe('RS256');

      const s = await portalSignIn('rs@example.com');
      expect(header(s.accessToken).alg).toBe('HS256');
      expect(typ(s.accessToken)).toBe('eu_portal');
      expect((await usersMe(s.accessToken, true)).statusCode).toBe(200);
      expect((await usersMe(s.accessToken, false)).statusCode).toBe(401);

      const rotated = (await refresh(s.refreshToken, true)).json().data as Session;
      expect(header(rotated.accessToken).alg).toBe('HS256');
      expect(typ(rotated.accessToken)).toBe('eu_portal');

      const jwks = (await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json() as { keys: object[] };
      expect(jwks.keys.length).toBeGreaterThan(0);
      for (const jwk of jwks.keys) {
        const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
        expect(() => jwt.verify(s.accessToken, publicKey, { algorithms: ['RS256'] })).toThrow();
      }
    });

    it('refuses an RS256 token typed eu_portal, even with the caller secret', async () => {
      const userId = await makeEndUser('forge@example.com');
      const { tokenGeneration } = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      const key = await getActiveSigningKey();
      const mint = (t: string) =>
        jwt.sign({ typ: t, sub: userId, applicationId: appId, gen: tokenGeneration }, key.privatePem, {
          algorithm: 'RS256',
          keyid: key.kid,
          expiresIn: 300,
        });
      // The same token typed eu_access is accepted, so the refusal below is the typ.
      expect((await usersMe(mint('eu_access'), true)).statusCode).toBe(200);
      expect((await usersMe(mint('eu_portal'), true)).statusCode).toBe(401);
      expect((await authMe(mint('eu_portal'), true)).statusCode).toBe(401);
    });
  });

  describe("with the portal's own credential: publishable key, Origin and caller secret", () => {
    beforeEach(async () => {
      const application = await prisma.application.update({
        where: { id: appId },
        data: { corsOrigins: ['https://app.example.com'], hostedPortalEnabled: true },
      });
      publishable = { key: application.publicKey, origin: PORTAL_ORIGIN };
    });

    it('signs in to a portal session, and without the caller secret is refused for want of a device', async () => {
      await makeEndUser('pub@example.com');
      const s = await portalSignIn('pub@example.com');
      expect(typ(s.accessToken)).toBe('eu_portal');
      expect((await headRow(s.accessToken)).kind).toBe('portal');

      const bare = await signIn('pub@example.com');
      expect(bare.statusCode).toBe(400);
      expect(bare.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');

      publishable = { key: publishable!.key, origin: 'https://evil.example.com' };
      const foreign = await signIn('pub@example.com', { portal: true });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('honours the token and the refresh token only with the caller secret', async () => {
      await makeEndUser('pubtok@example.com');
      const s = await portalSignIn('pubtok@example.com');
      expect((await usersMe(s.accessToken, true)).statusCode).toBe(200);
      expect((await usersMe(s.accessToken, false)).statusCode).toBe(401);
      expect((await refresh(s.refreshToken, false)).json().error.code).toBe('REFRESH_TOKEN_INVALID');
      const rotated = await refresh(s.refreshToken, true);
      expect(rotated.statusCode).toBe(200);
      expect(typ((rotated.json().data as Session).accessToken)).toBe('eu_portal');
    });

    const devices = (accessToken: string, method: 'GET' | 'DELETE', id = '') =>
      app.inject({
        method,
        url: `/api/v1/users/me/devices${id ? `/${id}` : ''}`,
        headers: { ...keyAuth(), 'x-rekey-user-token': accessToken, ...PORTAL },
      });

    it('lists and releases a device under self-service release, and the portal session survives', async () => {
      await makeEndUser('pubrel@example.com');
      const laptop = (await signIn('pubrel@example.com', { fingerprint: 'fp-pub-release-1' })).json().data as Session;
      const s = await portalSignIn('pubrel@example.com');
      await new Promise((r) => setTimeout(r, 1_100));

      const listed = await devices(s.accessToken, 'GET');
      expect(listed.statusCode).toBe(200);
      expect(JSON.stringify(listed.json().data)).toContain(laptop.deviceId!);

      expect((await devices(s.accessToken, 'DELETE', laptop.deviceId!)).statusCode).toBe(200);
      expect((await refresh(laptop.refreshToken, false)).json().error.code).toBe('REFRESH_TOKEN_REVOKED');
      expect((await usersMe(s.accessToken, true)).statusCode).toBe(200);
    });

    it('refuses the release under server_only release', async () => {
      await setAuthConfig({ deviceRelease: 'server_only' });
      await makeEndUser('pubsrv@example.com');
      const laptop = (await signIn('pubsrv@example.com', { fingerprint: 'fp-pub-server-01' })).json().data as Session;
      const s = await portalSignIn('pubsrv@example.com');
      expect((await devices(s.accessToken, 'GET')).statusCode).toBe(200);
      const refused = await devices(s.accessToken, 'DELETE', laptop.deviceId!);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('DEVICE_SELF_RELEASE_DISABLED');
      expect((await prisma.device.findUniqueOrThrow({ where: { id: laptop.deviceId! } })).status).toBe('ACTIVE');
    });
  });
});
