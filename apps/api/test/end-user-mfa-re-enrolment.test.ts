/**
 * /auth/mfa/setup cannot replace an enrolled authenticator without a current
 * code: resetting enrolment would reach the same end as /mfa/disable without
 * passing its guard.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { endUsersConfirmTheirEmail } from './confirmed-accounts.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

endUsersConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';

interface Fixture {
  operatorToken: string;
  applicationId: string;
  liveKey: string;
  publicKey: string;
  endUserId: string;
  endUserToken: string;
  endUserEmail: string;
}

describe('end-user MFA re-enrolment', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  async function bootstrap(label: string): Promise<Fixture> {
    const tag = `${label}-${++n}-${Math.random().toString(36).slice(2, 7)}`;
    const op = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${tag}@example.com`, password: PASSWORD, workspaceName: 'WS' },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { name: `App ${tag}`, slug: tag },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    // Enable MFA + organizations + passkeys on the Application so the routes
    // under test are reachable at all.
    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          methods: ['password', 'passkey'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: true,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
          mfa: 'optional',
          webauthn: { rpId: 'localhost', rpOrigins: ['http://localhost:3030'], rpName: 'T' },
        } as never,
      },
    });

    const endUserEmail = `eu-${tag}@example.com`;
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: endUserEmail, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      operatorToken: op.accessToken,
      applicationId: application.id,
      liveKey,
      publicKey: application.publicKey,
      endUserId: eu.endUser.id,
      endUserToken: eu.accessToken,
      endUserEmail,
    };
  }

  /** Enroll TOTP for an end-user via the publishable surface. */
  async function enrollMfa(f: Fixture): Promise<() => string> {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: {
        authorization: `Bearer ${f.publicKey}`,
        'x-rekey-user-token': f.endUserToken,
      },
    });
    expect(setup.statusCode).toBe(201);
    const totp = OTPAuth.URI.parse((setup.json().data as { otpauthUrl: string }).otpauthUrl);
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: {
        authorization: `Bearer ${f.publicKey}`,
        'x-rekey-user-token': f.endUserToken,
      },
      payload: { code: totp.generate() },
    });
    expect(confirm.statusCode).toBe(200);
    // The confirming code spent this step (lib/mfa-replay.ts), so later proofs use the next one.
    return () => totp.generate({ timestamp: Date.now() + 30_000 });
  }

  describe('MFA is not removable with a stolen token via /mfa/setup', () => {
    it('a browser caller cannot re-enroll over an enrolled authenticator without a code', async () => {
      const f = await bootstrap('mfa-setup');
      const code = await enrollMfa(f);

      const rebind = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.publicKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      // Was 201 with a fresh secret and `enrolledAt: null`, the account's real
      // authenticator silently stopped counting, which is what /mfa/disable
      // demands a code to prevent.
      expect(rebind.statusCode).toBe(401);
      expect(rebind.json().error.code).toBe('MFA_CODE_INVALID');

      const status = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/mfa/status',
        headers: {
          authorization: `Bearer ${f.publicKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      expect((status.json().data as { enabled: boolean }).enabled).toBe(true);

      const allowed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.publicKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
        payload: { code: code() },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('a SECRET-key caller keeps the previous contract', async () => {
      const f = await bootstrap('mfa-secret');
      await enrollMfa(f);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      // The customer's backend is the trusted gate, same split /mfa/disable
      // already makes. Changing this would break published SDK signatures.
      expect(res.statusCode).toBe(201);
    });
  });

});
