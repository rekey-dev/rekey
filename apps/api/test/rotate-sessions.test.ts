/**
 * The session kill switch: rotating an Application's sessions refuses every
 * access and refresh token issued before the rotation.
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
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
  endUserAccess: string;
  endUserId: string;
}

describe("rotating an application's sessions", () => {
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
              rpName: 'Rekey Test',
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
        payload: { email: `eu-a4-${slug}@example.com`, password: 'pw-one-two-three', emailVerified: true },
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
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': session.accessToken },
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
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': session.accessToken },
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
    const events = (
      log.json().data as { items: Array<{ type: string; applicationId: string | null }> }
    ).items;
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
