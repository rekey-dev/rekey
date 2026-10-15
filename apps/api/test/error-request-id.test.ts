/**
 * Every error envelope carries `requestId`, the response carries
 * `X-Request-Id`, and a 500 names the request id in its `fix` string.
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

describe('request ids on error responses', () => {
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
  it('error envelope includes requestId AND X-Request-Id header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'nope@example.com', password: 'whatever-long' },
    });
    expect(res.statusCode).toBe(401);
    const headerId = res.headers['x-request-id'];
    expect(typeof headerId).toBe('string');
    expect((headerId as string).length).toBeGreaterThan(0);

    const envelope = res.json() as {
      success: false;
      error: { code: string; requestId?: string };
    };
    expect(envelope.error.code).toBe('INVALID_CREDENTIALS');
    expect(envelope.error.requestId).toBe(headerId);
  });

});
