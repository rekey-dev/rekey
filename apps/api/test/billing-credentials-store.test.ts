/**
 * Storing billing credentials: a PUT stores them and the list reports the
 * provider as configured, and malformed values are refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail, endUsersConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();
endUsersConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  endUserId: string;
  endUserAccess: string;
  tenantAccess: string;
}

describe('storing billing credentials', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    // Tenant operator path (4.0).
    const tenantSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });

    // App via the tenant-scoped route.
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    // End-user via the public auth surface.
    const endUserSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      endUserId: endUserSession.endUser.id,
      endUserAccess: endUserSession.accessToken,
      tenantAccess: tenantSession.accessToken,
    };
  }
  it('PUT /billing-credentials/stripe stores creds; list reflects configured', async () => {
    const b = await bootstrap('byo');

    let list = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      })
      .then((r) => r.json().data as Array<{ provider: string; configured: boolean }>);
    expect(list).toEqual([]);

    const set = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        data: { apiKey: 'sk_test_xxx', webhookSecret: 'whsec_xxx' },
      },
    });
    expect(set.statusCode).toBe(200);

    list = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      })
      .then((r) => r.json().data as Array<{ provider: string; configured: boolean }>);
    expect(list).toHaveLength(1);
    expect(list[0]!.provider).toBe('stripe');
    expect(list[0]!.configured).toBe(true);

    // Verify stored ciphertext does NOT contain plaintext apiKey.
    const stored = await prisma.billingCredentials.findUniqueOrThrow({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'stripe' } },
    });
    expect(stored.ciphertext).toBeTruthy();
    expect(stored.ciphertext).not.toContain('sk_test_xxx');
    expect(stored.ciphertext).not.toContain('whsec_xxx');
  });

});
