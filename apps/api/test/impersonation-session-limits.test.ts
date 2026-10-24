/**
 * An impersonation session can be ended, which kills its token, and it cannot
 * rebind the impersonated user's MFA, passkeys or password.
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

describe('impersonation session limits', () => {
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

  describe('impersonation is revocable and cannot rebind credentials', () => {
    async function impersonate(f: Fixture): Promise<{ token: string; impersonationId: string }> {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${f.applicationId}/end-users/${f.endUserId}/impersonate`,
        headers: { authorization: `Bearer ${f.operatorToken}` },
        payload: { reason: 'support' },
      });
      expect(res.statusCode).toBe(200);
      const d = res.json().data as { accessToken: string; impersonationId: string };
      return { token: d.accessToken, impersonationId: d.impersonationId };
    }

    it('ending the session writes endedAt AND kills the token', async () => {
      const f = await bootstrap('imp-end');
      const { token, impersonationId } = await impersonate(f);

      // Live to start with.
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(before.statusCode).toBe(200);

      const ended = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${f.applicationId}/end-users/${f.endUserId}/impersonate/end`,
        headers: { authorization: `Bearer ${f.operatorToken}` },
      });
      expect(ended.statusCode).toBe(200);
      expect((ended.json().data as { ended: number }).ended).toBe(1);

      // `endedAt` was documented in prisma/schema.prisma and written by no code
      // path at all, this is the first thing that writes it.
      const row = await prisma.impersonationAudit.findUniqueOrThrow({
        where: { id: impersonationId },
      });
      expect(row.endedAt).not.toBeNull();

      // And it is a revocation, not an annotation: the minted token stops
      // working immediately, well inside its 5-minute life.
      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(after.statusCode).toBe(401);
      expect(after.json().error.code).toBe('IMPERSONATION_SESSION_ENDED');
    });

    it('cannot rebind the victim\'s MFA, passkeys, or password', async () => {
      const f = await bootstrap('imp-cred');
      const { token } = await impersonate(f);

      const asImpersonator = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
        app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
          ...(payload !== undefined ? { payload } : {}),
        } as never);

      const mfaSetup = await asImpersonator('POST', '/api/v1/auth/mfa/setup');
      // Was 201: a 5-minute support session could bind the account's second
      // factor to an authenticator the operator controls, permanently.
      expect(mfaSetup.statusCode).toBe(403);
      expect(mfaSetup.json().error.code).toBe('IMPERSONATION_ACTION_FORBIDDEN');

      // Erasure outlives any token: a support session must not erase the
      // account and have it logged as the user deleting themselves.
      const erase = await asImpersonator('DELETE', '/api/v1/users/me');
      expect(erase.statusCode).toBe(403);
      expect(erase.json().error.code).toBe('IMPERSONATION_ACTION_FORBIDDEN');
      expect((await prisma.endUser.findUniqueOrThrow({ where: { id: f.endUserId } })).erasedAt).toBeNull();

      const mfaDisable = await asImpersonator('POST', '/api/v1/auth/mfa/disable');
      expect(mfaDisable.statusCode).toBe(403);

      const passkey = await asImpersonator('POST', '/api/v1/auth/passkey/register/start');
      expect(passkey.statusCode).toBe(403);

      const password = await asImpersonator('POST', '/api/v1/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: 'operator-chose-this-one',
      });
      expect(password.statusCode).toBe(403);

      // The password really did not change.
      const stillWorks = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${f.liveKey}` },
        payload: { email: f.endUserEmail, password: PASSWORD },
      });
      expect(stillWorks.statusCode).toBe(200);

      // Reads are untouched, support work is what impersonation is for.
      const read = await asImpersonator('POST', '/api/v1/auth/mfa/setup');
      expect(read.statusCode).toBe(403);
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(me.statusCode).toBe(200);
    });

    it('an ordinary end-user session is unaffected by any of it', async () => {
      const f = await bootstrap('imp-normal');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      expect(res.statusCode).toBe(201);
    });
  });

});
