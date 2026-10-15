/**
 * Stored billing credentials that no longer decrypt (a rotated key, a damaged
 * row) raise BILLING_CREDENTIALS_DECRYPT_FAILED instead of being used as junk.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
  userId: string;
  userAccess: string;
}

describe('billing credentials that no longer decrypt', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const ts = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-a2-${slug}@example.com`,
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
        payload: { name: `App ${slug}`, slug: `a2-${slug}`, enableBilling: true },
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
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `eu-a2-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then(
        (r) =>
          r.json().data as {
            accessToken: string;
            endUser: { id: string };
          },
      );
    await configureSandboxStripe(application.id);
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: ts.accessToken,
      userId: eu.endUser.id,
      userAccess: eu.accessToken,
    };
  }

  it('billing credentials with corrupted ciphertext fail-loud at unwrap, not silent', async () => {
    const b = await bootstrap('creds-bad');
    // Corrupt the stored ciphertext to simulate key rotation / bit rot.
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'stripe' } },
      data: { ciphertext: 'v1.deadbeef.deadbeef.deadbeef' },
    });
    const { billingCredentialsService } = await import('../src/modules/billing/credentials.service.js');
    await expect(billingCredentialsService.loadDecrypted(b.applicationId, 'stripe')).rejects.toMatchObject({
      code: 'BILLING_CREDENTIALS_DECRYPT_FAILED',
    });
  });

  afterAll(async () => {
    await prisma.couponRedemption.deleteMany({});
    await prisma.licenseActivation.deleteMany({});
    await prisma.license.deleteMany({});
    await prisma.coupon.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
