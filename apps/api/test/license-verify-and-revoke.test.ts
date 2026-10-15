/**
 * A licence is issued, verifies, and stops verifying once revoked.
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

describe('a licence verifies until it is revoked', () => {
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
  it('issue license → verify ok → revoke → verify revoked', async () => {
    const b = await bootstrap('lic');
    const issue = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/licenses`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { endUserId: b.endUserId, kind: 'PERPETUAL' },
    });
    expect(issue.statusCode).toBe(201);
    const issued = issue.json().data as { license: { id: string }; rawKey: string };
    expect(issued.rawKey).toMatch(/^rl_lic_/);

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { key: issued.rawKey, machineFingerprint: 'machine-1' },
    });
    expect((verify.json().data as { ok: boolean }).ok).toBe(true);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/licenses/${issued.license.id}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { key: issued.rawKey, machineFingerprint: 'machine-1' },
    });
    expect((after.json().data as { ok: boolean; reason?: string }).reason).toBe('revoked');
  });
});
