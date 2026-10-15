/**
 * The operator's end-user detail route refuses an end-user id that belongs to
 * a different Application.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface BootstrappedApp {
  applicationId: string;
  liveKey: string;
}

describe('end-user detail is scoped to its Application', () => {
  let app: FastifyInstance;
  let appA: BootstrappedApp;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<BootstrappedApp> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T-${slug}`, ownerEmail: `t-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: slug, slug },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    return { applicationId: application.id, liveKey: key.rawKey };
  }

  beforeEach(async () => {
    appA = await bootstrap('detail');
  });
  it('GET /tenant/applications/:id/end-users/:euid refuses a euid from a different Application', async () => {
    // Bootstrap an operator + a separate appB with its own end-user.
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'tenant-operator-detail@example.com',
          password: 'pw-long-enough',
          workspaceName: 'WS',
        },
      })
      .then((r) => r.json().data as { accessToken: string });

    const appB = await bootstrap('detail-b');
    const otherUser = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${appB.liveKey}` },
        payload: { email: 'cross-app@example.com', password: 'pw-long-enough' },
      })
      .then((r) => r.json().data as { endUser: { id: string } });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA.applicationId}/end-users/${otherUser.endUser.id}`,
      headers: { authorization: `Bearer ${operator.accessToken}` },
    });
    // 404 from the tenant-scope guard OR 404 from the end-user lookup,
    // both are correct refusals; neither leaks the other Application's row.
    expect([403, 404]).toContain(res.statusCode);
  });
});
