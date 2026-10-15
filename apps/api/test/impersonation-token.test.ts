/**
 * Operator impersonation of an end user: an OWNER can mint the token, the mint
 * is audited, the token carries the `imp` claim, lives five minutes at most and
 * comes with no refresh token.
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

describe('impersonation tokens', () => {
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

    // The token verifies as a regular eu_access, middleware accepts it.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': data.accessToken,
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
  afterAll(async () => {
    await prisma.webAuthnCredential.deleteMany({});
    await prisma.impersonationAudit.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
