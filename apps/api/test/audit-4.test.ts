/**
 * Audit-4 / passkey (WebAuthn) regression tests.
 *
 * WebAuthn end-to-end testing requires a real authenticator + browser, so
 * the verify path is stubbed via `vi.mock('@simplewebauthn/server', …)`.
 * What we actually test:
 *
 *   - Registration options bind to the Application's configured rpId.
 *   - Successful registration persists a `WebAuthnCredential` row with the
 *     credential id from the (mocked) verifier output.
 *   - Authentication consume mints a session shape identical to /sign-in
 *     (passkeys are a strong factor; MFA challenge is bypassed).
 *   - Cross-Application credential lookup is refused (the credential
 *     belongs to App A; presenting it to App B fails 401).
 *   - WEBAUTHN_NOT_CONFIGURED is surfaced when `authConfig.webauthn` is
 *     absent — operators must opt in deliberately.
 *   - listPasskeys + deletePasskey are scoped to the calling user.
 *
 * The counter-advancement contract is enforced by SimpleWebAuthn itself
 * and isn't re-tested here; the stubbed verifier just returns the next
 * counter value the test expects to be persisted.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@simplewebauthn/server', async () => {
  const actual = await vi.importActual<typeof import('@simplewebauthn/server')>(
    '@simplewebauthn/server',
  );
  return {
    ...actual,
    // verifyRegistrationResponse: pretend the browser's response is valid and
    // return a stable credential id + public key. The test then asserts a
    // row landed in the DB.
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-test-fixture',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ['internal'] as const,
        },
      },
    })),
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })),
  };
});

import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
  endUserAccess: string;
  endUserId: string;
}

describe('Audit-4 passkeys', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string, withWebAuthn = true): Promise<Bootstrapped> {
    const ts = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-a4-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: `App ${slug}`, slug: `a4-${slug}` },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    if (withWebAuthn) {
      // Configure WebAuthn on the Application. Direct schema mutation
      // since the panel endpoint surface isn't the subject of this test.
      await prisma.application.update({
        where: { id: application.id },
        data: {
          authConfig: {
            methods: ['password', 'passkey'],
            passwordMinLength: 8,
            redirectUrls: [],
            organizationsEnabled: false,
            signupEnabled: true,
            passwordBreachCheckEnabled: false,
            webauthn: {
              rpId: 'localhost',
              rpOrigins: ['http://localhost:3030'],
              rpName: 'ReliPay Test',
            },
          } as never,
        },
      });
    }

    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `eu-a4-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: ts.accessToken,
      endUserAccess: eu.accessToken,
      endUserId: eu.endUser.id,
    };
  }

  it('register/start returns options bound to the Application rpId', async () => {
    const b = await bootstrap('reg-options');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/register/start',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    const data = r.json().data as {
      options: { rp: { id: string }; challenge: string };
      expectedChallenge: string;
    };
    expect(data.options.rp.id).toBe('localhost');
    expect(data.expectedChallenge).toBe(data.options.challenge);
  });

  it('register/complete persists a WebAuthnCredential and lists it', async () => {
    const b = await bootstrap('reg-persist');
    const start = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/register/start',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-relipay-user-token': b.endUserAccess,
        },
        payload: {},
      })
      .then((r) => r.json().data as { expectedChallenge: string });

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/register/complete',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
      payload: {
        response: { id: 'cred-test-fixture' }, // shape doesn't matter; mock ignores it
        expectedChallenge: start.expectedChallenge,
        deviceName: 'iPhone Test Fixture',
      },
    });
    expect(complete.statusCode).toBe(200);
    const data = complete.json().data as { credentialId: string; deviceName: string | null };
    expect(data.credentialId).toBe('cred-test-fixture');
    expect(data.deviceName).toBe('iPhone Test Fixture');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/passkeys',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
    });
    expect(list.statusCode).toBe(200);
    const passkeys = list.json().data as Array<{ credentialId: string }>;
    expect(passkeys.find((p) => p.credentialId === 'cred-test-fixture')).toBeTruthy();
  });

  it('authenticate/complete mints a session that bypasses MFA challenge', async () => {
    const b = await bootstrap('auth-success');
    // Pre-register a credential row for the user (skip the start/complete dance).
    await prisma.webAuthnCredential.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        credentialId: 'auth-cred-fixture',
        publicKey: 'AQID',
        counter: BigInt(0),
        transports: ['internal'],
      },
    });

    const start = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/authenticate/start',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: {},
      })
      .then((r) => r.json().data as { expectedChallenge: string });

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/authenticate/complete',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: {
        response: { id: 'auth-cred-fixture' },
        expectedChallenge: start.expectedChallenge,
      },
    });
    expect(complete.statusCode).toBe(200);
    const data = complete.json().data as { mfaRequired: boolean; accessToken?: string };
    expect(data.mfaRequired).toBe(false);
    expect(data.accessToken).toBeTruthy();

    // Counter advanced to 1 (per the mock).
    const cred = await prisma.webAuthnCredential.findUnique({
      where: { credentialId: 'auth-cred-fixture' },
    });
    expect(Number(cred!.counter)).toBe(1);
    expect(cred!.lastUsedAt).toBeTruthy();
  });

  it('credential registered under Application A is refused via Application B', async () => {
    const a = await bootstrap('cross-app-a');
    const c = await bootstrap('cross-app-c');
    await prisma.webAuthnCredential.create({
      data: {
        applicationId: a.applicationId,
        endUserId: a.endUserId,
        credentialId: 'cross-cred',
        publicKey: 'AQID',
        counter: BigInt(0),
        transports: ['internal'],
      },
    });

    const start = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/authenticate/start',
        headers: { authorization: `Bearer ${c.liveKey}` },
        payload: {},
      })
      .then((r) => r.json().data as { expectedChallenge: string });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/authenticate/complete',
      headers: { authorization: `Bearer ${c.liveKey}` },
      payload: {
        response: { id: 'cross-cred' },
        expectedChallenge: start.expectedChallenge,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBAUTHN_AUTH_INVALID');
  });

  it('WEBAUTHN_NOT_CONFIGURED when authConfig.webauthn is absent', async () => {
    const b = await bootstrap('unconfigured', false);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/register/start',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('WEBAUTHN_NOT_CONFIGURED');
  });

  it('deletePasskey is scoped to the calling user (cross-user delete is a no-op)', async () => {
    const b = await bootstrap('del-scope');
    // Create another user under the same Application.
    const otherEu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'other-del@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { endUser: { id: string } });
    const cred = await prisma.webAuthnCredential.create({
      data: {
        applicationId: b.applicationId,
        endUserId: otherEu.endUser.id,
        credentialId: 'other-user-cred',
        publicKey: 'AQID',
        counter: BigInt(0),
        transports: ['internal'],
      },
    });

    // b.endUserAccess belongs to the FIRST user; deleting otherEu's cred id
    // should be a no-op (no row matches their endUserId).
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/passkeys/${cred.id}`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(false);

    // Verify the row still exists.
    const stillThere = await prisma.webAuthnCredential.findUnique({ where: { id: cred.id } });
    expect(stillThere).toBeTruthy();
  });

  // ---------- Impersonation ----------

  it('OWNER can mint an impersonation token; audit row written; token carries `imp` claim', async () => {
    const b = await bootstrap('impersonate');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${b.endUserId}/impersonate`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { reason: 'debugging ticket #42' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      accessToken: string;
      accessTokenExpiresAt: string;
      impersonatedUser: { id: string };
    };
    expect(data.accessToken).toBeTruthy();
    expect(data.impersonatedUser.id).toBe(b.endUserId);

    // The token verifies as a regular eu_access — middleware accepts it.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': data.accessToken,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.id).toBe(b.endUserId);

    // Audit row exists with the operator id + the reason. End-user JWTs are
    // signed with a per-app derived key, so verification needs the app id +
    // its current tokenGeneration (1 for a fresh app, but read it to be robust).
    const { verifyUserAccessToken } = await import('../src/lib/jwt.js');
    const appRow = await prisma.application.findUniqueOrThrow({
      where: { id: b.applicationId },
      select: { tokenGeneration: true },
    });
    const claims = verifyUserAccessToken(data.accessToken, b.applicationId, appRow.tokenGeneration);
    expect(claims).toBeTruthy();
    const audits = await prisma.impersonationAudit.findMany({
      where: { applicationId: b.applicationId, endUserId: b.endUserId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe('debugging ticket #42');
    expect(audits[0]!.operatorUserId).toBe(claims!.imp);
  });

  it('impersonation token has a short (≤ 5 min) lifetime and no refresh token alongside', async () => {
    const b = await bootstrap('impersonate-lifetime');
    const res = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${b.endUserId}/impersonate`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: {},
      })
      .then((r) => r.json().data as { accessToken: string; accessTokenExpiresAt: string });
    const lifetimeMs = new Date(res.accessTokenExpiresAt).getTime() - Date.now();
    expect(lifetimeMs).toBeGreaterThan(0);
    expect(lifetimeMs).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    // No refresh token is exposed.
    expect((res as Record<string, unknown>).refreshToken).toBeUndefined();
  });

  it('SESSION KILL-SWITCH: rotate-sessions invalidates live access + refresh tokens', async () => {
    const b = await bootstrap('killswitch');

    // A fresh end-user with a full session (access + refresh).
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'killswitch-user@example.com', password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode).toBe(201);
    const session = signUp.json().data as { accessToken: string; refreshToken: string };

    // Access token works before rotation.
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': session.accessToken },
    });
    expect(before.statusCode).toBe(200);

    // Operator fires the kill-switch.
    const rotate = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/rotate-sessions`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(rotate.statusCode).toBe(200);
    expect(
      (rotate.json().data as { sessionsRevoked: number }).sessionsRevoked,
    ).toBeGreaterThanOrEqual(1);

    // The same access token is now rejected (signed under the old generation).
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': session.accessToken },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('USER_TOKEN_INVALID');

    // And the revoked refresh token can't mint a new session either.
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    // The rotation was recorded in the security audit log.
    const log = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/security-events',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(log.statusCode).toBe(200);
    const events = (log.json().data as { events: Array<{ type: string; applicationId: string | null }> })
      .events;
    expect(events.some((e) => e.type === 'app.sessions_rotated' && e.applicationId === b.applicationId)).toBe(
      true,
    );
  });

  afterAll(async () => {
    await prisma.webAuthnCredential.deleteMany({});
    await prisma.impersonationAudit.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
