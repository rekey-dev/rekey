/**
 * An OAuth callback (mock provider) creates the end user and signs them in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
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

describe('end-user OAuth sign-in', () => {
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
  it('OAuth callback creates a new EndUser and signs them in (mock provider)', async () => {
    const b = await bootstrap('oauth-new');
    // Configure the application's OAuth.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsecret',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });

    // Inject a mock provider that pretends Google returned a stable id +
    // verified email. `emailVerified` is now required by the provider
    // contract, see oauth/providers/types.ts. Verified-only auto-link is
    // the security gate against unverified-email account takeover.
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: 'g-acct-new',
        email: 'newvia-oauth@example.com',
        emailVerified: true,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { code: 'mock-code' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      endUser: { email: string; emailVerified: boolean };
      accessToken: string;
    };
    expect(data.endUser.email).toBe('newvia-oauth@example.com');
    expect(data.endUser.emailVerified).toBe(true);
    expect(data.accessToken).toBeTruthy();
  });

});
