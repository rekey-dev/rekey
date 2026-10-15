/**
 * GET /api/v1/me answers in the ApplicationDto shape: `environment` present,
 * the two config objects schema-parsed.
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

describe('GET /me response shape', () => {
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

  describe('GET /me matches ApplicationDto', () => {
    it('sends `environment` and schema-parsed config objects', async () => {
      const f = await bootstrap('medto');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me/',
        headers: { authorization: `Bearer ${f.liveKey}` },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as {
        environment?: string;
        authConfig: Record<string, unknown>;
        billingConfig: Record<string, unknown>;
      };
      // `environment` is REQUIRED in ApplicationDtoSchema and was never sent:
      // the documented SDK smoke test returned `undefined` typed as an enum.
      expect(data.environment).toBeDefined();
      expect(['PRODUCTION', 'STAGING', 'DEVELOPMENT']).toContain(data.environment);
      // The configs were passed through as raw Prisma JSON typed `unknown`, so
      // AuthConfigSchema's defaults never ran. Parsed output always carries
      // these, whatever the stored row happens to contain.
      expect(typeof data.authConfig.passwordMinLength).toBe('number');
      expect(Array.isArray(data.authConfig.methods)).toBe(true);
      expect(data.billingConfig).toHaveProperty('enabled');

      // And the whole payload validates against the published schema.
      const { ApplicationDtoSchema } = await import('@rekey.dev/shared-types');
      expect(() => ApplicationDtoSchema.parse(data)).not.toThrow();
    });
  });
});
