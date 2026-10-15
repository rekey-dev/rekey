/**
 * An organization invitation can only be accepted by the invited email.
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

describe('organization invitation acceptance', () => {
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

  describe('organization invitations are bound to the invited email', () => {
    it('an unrelated account cannot accept an OWNER invite', async () => {
      const f = await bootstrap('orginv');

      const org = await app
        .inject({
          method: 'POST',
          url: '/api/v1/users/me/organizations/',
          headers: {
            authorization: `Bearer ${f.liveKey}`,
            'x-rekey-user-token': f.endUserToken,
          },
          payload: { name: 'Acme', slug: `acme-${Math.random().toString(36).slice(2, 8)}` },
        })
        .then((r) => (r.json().data as { organization: { id: string } }).organization);

      const invitedEmail = `invited-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.id}/invitations`,
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
        payload: { email: invitedEmail, role: 'OWNER' },
      });
      expect(invite.statusCode, invite.body).toBe(201);
      const rawToken = (invite.json().data as { token: string }).token;

      // A completely unrelated account in the same Application: the holder of
      // the link is not the holder of the mailbox.
      const stranger = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${f.liveKey}` },
          payload: {
            email: `stranger-${Math.random().toString(36).slice(2, 8)}@example.com`,
            password: PASSWORD,
          },
        })
        .then((r) => r.json().data as { accessToken: string });

      const stolen = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': stranger.accessToken,
        },
        payload: { token: rawToken },
      });
      // Was 200 with an OWNER membership on somebody else's organization.
      expect(stolen.statusCode).toBe(403);
      expect(stolen.json().error.code).toBe('ORGANIZATION_INVITATION_EMAIL_MISMATCH');
      expect(
        await prisma.organizationMembership.count({ where: { organizationId: org.id } }),
      ).toBe(1);

      // The invited address still works, the token was not burned by the
      // refused attempt.
      const invited = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${f.liveKey}` },
          payload: { email: invitedEmail, password: PASSWORD },
        })
        .then((r) => r.json().data as { accessToken: string });
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': invited.accessToken,
        },
        payload: { token: rawToken },
      });
      expect(accepted.statusCode).toBe(200);
    });
  });

});
