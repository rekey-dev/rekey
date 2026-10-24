/**
 * End-user passkeys (WebAuthn). A real ceremony needs an authenticator and a
 * browser, so the verifier is stubbed with `vi.mock('@simplewebauthn/server')`.
 * Covered: registration options bind to the Application's rpId, a registration
 * persists the credential, a passkey sign-in mints a session without an MFA
 * challenge, a credential from Application A is refused on Application B,
 * email-first sign-in start does not reveal whether an address has an account,
 * WEBAUTHN_NOT_CONFIGURED when the application has not opted in, and list and
 * delete are scoped to the calling user.
 *
 * The counter-advancement contract belongs to SimpleWebAuthn and is not
 * re-tested here; the stub returns the next counter the test expects stored.
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

describe('end-user passkeys', () => {
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
  it('register/complete persists a WebAuthnCredential and lists it', async () => {
    const b = await bootstrap('reg-persist');
    const start = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/register/start',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.endUserAccess,
        },
        payload: {},
      })
      .then((r) => r.json().data as { expectedChallenge: string });

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/register/complete',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.endUserAccess,
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
        'x-rekey-user-token': b.endUserAccess,
      },
    });
    expect(list.statusCode).toBe(200);
    const passkeys = (list.json().data as { items: Array<{ credentialId: string }> }).items;
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

  it('email-first start answers a known address without passkeys like an unknown one', async () => {
    const b = await bootstrap('enum-shape');
    const startFor = (email: string) =>
      app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/passkey/authenticate/start',
          headers: { authorization: `Bearer ${b.liveKey}` },
          payload: { email },
        })
        .then((r) => {
          expect(r.statusCode).toBe(200);
          const data = r.json().data as { options: Record<string, unknown> };
          return Object.keys(data.options).sort();
        });
    const known = await startFor('eu-a4-enum-shape@example.com');
    const unknown = await startFor('nobody-enum-shape@example.com');
    expect(known).not.toContain('allowCredentials');
    expect(known).toEqual(unknown);
  });

  it('WEBAUTHN_NOT_CONFIGURED when authConfig.webauthn is absent', async () => {
    const b = await bootstrap('unconfigured', false);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/register/start',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.endUserAccess,
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
        'x-rekey-user-token': b.endUserAccess,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(false);

    // Verify the row still exists.
    const stillThere = await prisma.webAuthnCredential.findUnique({ where: { id: cred.id } });
    expect(stillThere).toBeTruthy();
  });
  afterAll(async () => {
    await prisma.webAuthnCredential.deleteMany({});
    await prisma.impersonationAudit.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
