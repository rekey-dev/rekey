/**
 * Both end-user passkey ceremonies require user verification. Passkey sign-in
 * mints a session directly, so a UV=0 assertion would downgrade password plus
 * TOTP to a touch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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

describe('end-user passkey user verification', () => {
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

  describe('passkey ceremonies require user verification', () => {
    it('authenticate/start asks for it, a UV=0 assertion is not a sign-in', async () => {
      const f = await bootstrap('pk-uv');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/authenticate/start',
        headers: { authorization: `Bearer ${f.publicKey}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const { options } = res.json().data as { options: { userVerification: string } };
      // Was 'preferred', and the verifier passed `requireUserVerification: false`
      //, so an authenticator that skipped the PIN/biometric still produced a
      // full session via `issuePair`, replacing password + TOTP with a touch.
      expect(options.userVerification).toBe('required');
    });

    it('register/start asks for it too, so nothing weaker can be enrolled', async () => {
      const f = await bootstrap('pk-uv-reg');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/register/start',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      expect(res.statusCode).toBe(200);
      const { options } = res.json().data as {
        options: { authenticatorSelection: { userVerification: string } };
      };
      expect(options.authenticatorSelection.userVerification).toBe('required');
    });
  });

});
