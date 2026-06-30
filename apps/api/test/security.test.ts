/**
 * Phase-1 security hardening: regression tests for the load-bearing
 * guarantees:
 *
 *   - MFA enforcement at sign-in (mfaChallengeToken intermediate).
 *   - OAuth auto-link refuses on unverified emails.
 *   - JWT `typ` claim refuses cross-type confusion.
 *   - API key scope enforcement (`auth:read` key can't write).
 *
 * Refresh-token family-revocation is covered alongside the existing
 * rotation tests in refresh.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { issueMfaChallengeToken } from '../src/lib/jwt.js';
import * as OTPAuth from 'otpauth';

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('Phase-1 security hardening', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const tenantSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: tenantSession.accessToken,
    };
  }

  // ---------- MFA enforcement at sign-in ----------

  it('sign-in with MFA enrolled returns mfaChallengeToken instead of a session', async () => {
    const b = await bootstrap('mfa-signin');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'mfa@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    // Enroll MFA for that user.
    const setup = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-relipay-user-token': eu.accessToken,
        },
      })
      .then((r) => r.json().data as { otpauthUrl: string });
    const secret = new URL(
      setup.otpauthUrl.replace('otpauth://', 'https://x/'),
    ).searchParams.get('secret')!;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': eu.accessToken,
      },
      payload: { code: totp.generate() },
    });

    // Now sign in by password — must return mfaRequired, not a session.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'mfa@example.com', password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      mfaRequired: boolean;
      mfaChallengeToken?: string;
      accessToken?: string;
      refreshToken?: string;
    };
    expect(data.mfaRequired).toBe(true);
    expect(data.mfaChallengeToken).toBeTruthy();
    expect(data.accessToken).toBeUndefined();
    expect(data.refreshToken).toBeUndefined();

    // Exchange the challenge token + current TOTP for a real session.
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa-verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { mfaChallengeToken: data.mfaChallengeToken, code: totp.generate() },
    });
    expect(verify.statusCode).toBe(200);
    const verified = verify.json().data as { mfaRequired: boolean; accessToken: string; refreshToken: string };
    expect(verified.mfaRequired).toBe(false);
    expect(verified.accessToken).toBeTruthy();
    expect(verified.refreshToken).toBeTruthy();
  });

  it('mfa-verify with wrong code refuses to mint a session', async () => {
    const b = await bootstrap('mfa-wrong');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'mfa-wrong@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    const setup = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-relipay-user-token': eu.accessToken,
        },
      })
      .then((r) => r.json().data as { otpauthUrl: string });
    const secret = new URL(
      setup.otpauthUrl.replace('otpauth://', 'https://x/'),
    ).searchParams.get('secret')!;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': eu.accessToken,
      },
      payload: { code: totp.generate() },
    });

    const challenge = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'mfa-wrong@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { mfaChallengeToken: string });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa-verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { mfaChallengeToken: challenge.mfaChallengeToken, code: '000000' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('MFA_CODE_INVALID');
  });

  it('MFA throttle: repeated wrong codes lock the credential (MFA_TOO_MANY_ATTEMPTS)', async () => {
    const b = await bootstrap('mfa-throttle');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'mfa-throttle@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });
    const setup = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': eu.accessToken },
      })
      .then((r) => r.json().data as { otpauthUrl: string });
    const secret = new URL(
      setup.otpauthUrl.replace('otpauth://', 'https://x/'),
    ).searchParams.get('secret')!;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': eu.accessToken },
      payload: { code: totp.generate() },
    });
    const challenge = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'mfa-throttle@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { mfaChallengeToken: string });

    // 5 wrong codes — each 401 INVALID; the 5th arms the lock.
    for (let i = 0; i < 5; i++) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa-verify',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { mfaChallengeToken: challenge.mfaChallengeToken, code: '000000' },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe('MFA_CODE_INVALID');
    }
    // Now locked — even the CORRECT code is refused (lock checked before verify).
    const locked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa-verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { mfaChallengeToken: challenge.mfaChallengeToken, code: totp.generate() },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('MFA_TOO_MANY_ATTEMPTS');
  });

  // ---------- Operator (tenant) MFA enforcement ----------

  it('operator sign-in with MFA enrolled returns an mfa challenge token', async () => {
    const opSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'op-mfa@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'WS Op',
        },
      })
      .then((r) => r.json().data as { accessToken: string });

    // Enroll MFA for the operator.
    const setup = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup',
        headers: { authorization: `Bearer ${opSession.accessToken}` },
      })
      .then((r) => r.json().data as { otpauthUrl: string });
    const secret = new URL(
      setup.otpauthUrl.replace('otpauth://', 'https://x/'),
    ).searchParams.get('secret')!;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
    await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup-confirm',
      headers: { authorization: `Bearer ${opSession.accessToken}` },
      payload: { code: totp.generate() },
    });

    // Now sign in — must hold the session.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email: 'op-mfa@example.com', password: 'pw-one-two-three' },
    });
    const signInData = signIn.json().data as {
      mfaRequired: boolean;
      mfaChallengeToken?: string;
      accessToken?: string;
    };
    expect(signInData.mfaRequired).toBe(true);
    expect(signInData.mfaChallengeToken).toBeTruthy();
    expect(signInData.accessToken).toBeUndefined();

    // Exchange + complete sign-in.
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa-verify',
      payload: {
        mfaChallengeToken: signInData.mfaChallengeToken,
        code: totp.generate(),
      },
    });
    expect(verified.statusCode).toBe(200);
    const session = verified.json().data as {
      mfaRequired: boolean;
      accessToken: string;
      refreshToken: string;
    };
    expect(session.mfaRequired).toBe(false);
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
  });

  // ---------- JWT typ claim ----------

  it('an MFA challenge token cannot pass as a session access token', async () => {
    const b = await bootstrap('typ');
    // Mint a challenge token directly — it has typ="eu_mfa_challenge".
    const { token } = issueMfaChallengeToken('does-not-matter', b.applicationId);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': token,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
  });

  // ---------- OAuth auto-link gate ----------

  it('OAuth callback refuses to auto-link to an existing user when email is unverified', async () => {
    const b = await bootstrap('oauth-unverified');
    // Create a password user first.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'collision@example.com', password: 'pw-one-two-three' },
    });
    // Configure Google OAuth so the route is willing to dispatch.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsecret',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });
    // Mock provider returns the SAME email but emailVerified=false.
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: 'g-unverified',
        email: 'collision@example.com',
        emailVerified: false,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { code: 'mock-code' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('OAUTH_EMAIL_NOT_VERIFIED');
  });

  it('OAuth new-user creation reflects emailVerified faithfully (not hardcoded true)', async () => {
    const b = await bootstrap('oauth-emailverified-faithful');
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsecret',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: 'g-newuser-unverified',
        email: 'newunverified@example.com',
        emailVerified: false,
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { code: 'mock-code' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { endUser: { emailVerified: boolean } };
    expect(data.endUser.emailVerified).toBe(false);
  });

  // ---------- API key scope enforcement ----------

  it('a key minted with auth:read is rejected at sign-in (auth:write required)', async () => {
    const b = await bootstrap('scope-read-only');
    const readKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/api-keys`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { name: 'read-only', mode: 'live', scopes: ['auth:read'] },
      })
      .then((r) => r.json().data as { rawKey: string });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${readKey.rawKey}` },
      payload: { email: 'whoever@example.com', password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
  });

  it('a key with auth:write implies auth:read (hierarchy)', async () => {
    const b = await bootstrap('scope-write-implies-read');
    const writeKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/api-keys`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { name: 'write-only', mode: 'live', scopes: ['auth:write'] },
      })
      .then((r) => r.json().data as { rawKey: string });

    // /me requires auth:read — auth:write should imply.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${writeKey.rawKey}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('legacy default scope ["*"] satisfies every required scope', async () => {
    // The bootstrap-provided liveKey defaults to ["*"] — verify it accepts
    // a write (sign-up) without issue. Belt-and-suspenders since we already
    // rely on this everywhere implicitly.
    const b = await bootstrap('scope-star');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'star@example.com', password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);
  });

  // ---------- Sessions list / per-device revoke ----------

  it('sign-up captures User-Agent + IP into the refresh row; /sessions lists them', async () => {
    const b = await bootstrap('sessions-ua');
    const ua = 'TestBrowser/1.0 (security-test)';
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}`, 'user-agent': ua },
        payload: { email: 'sessionsua@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': eu.accessToken,
      },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().data as Array<{ id: string; userAgent: string | null; ip: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userAgent).toBe(ua);
    expect(rows[0]!.id).toBeTruthy();
  });

  it('DELETE /sessions/:id revokes one session and the refresh stops working', async () => {
    const b = await bootstrap('sessions-revoke');
    // Two separate sign-ins → two refresh tokens for the same user.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}`, 'user-agent': 'DeviceA' },
      payload: { email: 'sessionsrev@example.com', password: 'pw-one-two-three' },
    });
    const secondSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}`, 'user-agent': 'DeviceB' },
        payload: { email: 'sessionsrev@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; refreshToken: string });

    const list = await app
      .inject({
        method: 'GET',
        url: '/api/v1/auth/sessions',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-relipay-user-token': secondSession.accessToken,
        },
      })
      .then((r) => r.json().data as Array<{ id: string; userAgent: string | null }>);
    expect(list).toHaveLength(2);
    const deviceA = list.find((r) => r.userAgent === 'DeviceA')!;
    expect(deviceA).toBeTruthy();

    // Revoke device A from device B's session.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${deviceA.id}`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': secondSession.accessToken,
      },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.revoked).toBe(true);

    // Idempotent — second revoke returns revoked=false.
    const del2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${deviceA.id}`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': secondSession.accessToken,
      },
    });
    expect(del2.json().data.revoked).toBe(false);
  });

  it('cross-user revoke by id is impossible (scoped by endUserId)', async () => {
    const b = await bootstrap('cross-user-rev');
    const userA = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'userA@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });
    const userB = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'userB@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });

    const userBSession = await app
      .inject({
        method: 'GET',
        url: '/api/v1/auth/sessions',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-relipay-user-token': userB.accessToken,
        },
      })
      .then((r) => (r.json().data as Array<{ id: string }>)[0]!);

    // User A tries to revoke User B's session by id.
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${userBSession.id}`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': userA.accessToken,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.revoked).toBe(false); // scoped to A's own user; B's row untouched
  });

  // ---------- Account linking ----------

  it('link/complete attaches an OAuth identity to the current user (verified-email gate honoured)', async () => {
    const b = await bootstrap('link-ok');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'linker@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsec',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: 'link-google-id',
        email: 'linker@example.com',
        emailVerified: true,
      }),
    });

    const linkRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/link/complete',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': eu.accessToken,
      },
      payload: { code: 'mock-code' },
    });
    expect(linkRes.statusCode).toBe(200);
    expect(linkRes.json().data.alreadyLinked).toBe(false);

    // Re-linking is idempotent.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/link/complete',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': eu.accessToken,
      },
      payload: { code: 'mock-code' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.alreadyLinked).toBe(true);
  });

  it('link refuses unverified emails (account-takeover guard)', async () => {
    const b = await bootstrap('link-unver');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'unver@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsec',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: 'unver-id',
        email: 'unver@example.com',
        emailVerified: false,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/link/complete',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': eu.accessToken,
      },
      payload: { code: 'mock-code' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('OAUTH_EMAIL_NOT_VERIFIED');
  });

  it('unlink refuses to leave the account with no sign-in method', async () => {
    const b = await bootstrap('unlink-lockout');
    // Create an OAuth-only user (no password). We do that by signing up
    // via OAuth — register a mock provider, configure it, and call the
    // public OAuth callback to create the user.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsec',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: 'oauth-only-id',
        email: 'oauthonly@example.com',
        emailVerified: true,
      }),
    });
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/oauth/google/callback',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { code: 'mock-code' },
      })
      .then((r) => r.json().data as { accessToken: string });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/oauth/google',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': session.accessToken,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('OAUTH_UNLINK_WOULD_LOCK_OUT');
  });

  it('GET /identities lists linked providers for the current user', async () => {
    const b = await bootstrap('list-ident');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'lister@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/identities',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': eu.accessToken,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  // Cleanup: prevent test users from accumulating across runs.
  afterAll(async () => {
    await prisma.endUser.deleteMany({
      where: { email: { contains: '@example.com' } },
    });
  });
});
