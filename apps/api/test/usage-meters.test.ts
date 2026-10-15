/**
 * A meter aggregates the events recorded against it, and an inactive meter
 * refuses new ones.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
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

describe('usage meters', () => {
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
  it('create meter → record events → aggregate sums quantity', async () => {
    const b = await bootstrap('usage');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/usage-meters`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    for (const q of [1, 5, 10]) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/usage/record',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { meterSlug: 'api_calls', quantity: q },
      });
    }
    const agg = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/aggregate?meterSlug=api_calls',
      headers: { authorization: `Bearer ${b.liveKey}` },
    });
    expect((agg.json().data as { total: number; count: number }).total).toBe(16);
    expect((agg.json().data as { total: number; count: number }).count).toBe(3);
  });

  it('record against an inactive meter is rejected', async () => {
    const b = await bootstrap('usage-inactive');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/usage-meters`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { slug: 'storage', name: 'Storage', unit: 'GB-hours' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/usage-meters/storage`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { active: false },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { meterSlug: 'storage', quantity: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('USAGE_METER_INACTIVE');
  });
});
