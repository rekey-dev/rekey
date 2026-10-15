/**
 * Magic-link sign-in: request a token (no transport in tests), verify it, get a
 * session. A verify creates the account when sign-up is enabled, a token works
 * once, and an application that has not enabled the method refuses it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('magic-link sign-in', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string, opts?: { magicLink?: boolean }): Promise<Bootstrapped> {
    const ts = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-a3-${slug}@example.com`,
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
        payload: { name: `App ${slug}`, slug: `a3-${slug}` },
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

    if (opts?.magicLink) {
      // Flip the Application's authConfig.methods to include magic_link.
      // Direct DB mutation is fine here, the API surface for editing
      // authConfig lives at /tenant/applications/:id but exercising it
      // is incidental to this test.
      await prisma.application.update({
        where: { id: application.id },
        data: {
          authConfig: {
            methods: ['password', 'magic_link'],
            passwordMinLength: 8,
            redirectUrls: [],
            organizationsEnabled: false,
            signupEnabled: true,
            passwordBreachCheckEnabled: false,
          } as never,
        },
      });
    }

    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: ts.accessToken,
    };
  }
  it('magic-link request + verify mints a session for an existing user', async () => {
    const b = await bootstrap('magic-existing', { magicLink: true });
    // Create the user via password sign-up first.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'magic-existing@example.com', password: 'pw-one-two-three' },
    });

    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'magic-existing@example.com' },
    });
    expect(req.statusCode).toBe(200);
    const reqData = req.json().data as { delivered: boolean; emailSent: boolean; magicLinkToken: string | null };
    expect(reqData.delivered).toBe(true);
    expect(reqData.emailSent).toBe(false); // no transport in test env
    expect(reqData.magicLinkToken).toBeTruthy();

    const ver = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: reqData.magicLinkToken },
    });
    expect(ver.statusCode).toBe(200);
    const verData = ver.json().data as { mfaRequired: boolean; accessToken?: string };
    expect(verData.mfaRequired).toBe(false);
    expect(verData.accessToken).toBeTruthy();
  });

  it('magic-link verify creates a new user when sign-up is enabled', async () => {
    const b = await bootstrap('magic-newuser', { magicLink: true });
    const req = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'magic-newuser@example.com' },
      })
      .then((r) => r.json().data as { magicLinkToken: string });

    const ver = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: req.magicLinkToken },
    });
    expect(ver.statusCode).toBe(200);
    const user = await prisma.endUser.findUnique({
      where: {
        applicationId_email: { applicationId: b.applicationId, email: 'magic-newuser@example.com' },
      },
    });
    expect(user).toBeTruthy();
    // Magic-link is itself proof of email ownership.
    expect(user!.emailVerified).toBe(true);
  });

  it('magic-link verify is single-use; replay refuses with MAGIC_LINK_USED', async () => {
    const b = await bootstrap('magic-replay', { magicLink: true });
    const req = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'magic-replay@example.com' },
      })
      .then((r) => r.json().data as { magicLinkToken: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: req.magicLinkToken },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: req.magicLinkToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('MAGIC_LINK_USED');
  });

  it('magic-link refused when method not enabled on the application', async () => {
    const b = await bootstrap('magic-disabled'); // no magic_link in methods
    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'magic-disabled@example.com' },
    });
    expect(req.statusCode).toBe(400);
    expect(req.json().error.code).toBe('AUTH_METHOD_DISABLED');
  });

  it('magic-link with sign-up disabled refuses new emails (enumeration-safe)', async () => {
    const b = await bootstrap('magic-noinvite', { magicLink: true });
    // Flip signupEnabled off.
    await prisma.application.update({
      where: { id: b.applicationId },
      data: {
        authConfig: {
          methods: ['password', 'magic_link'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: false,
          signupEnabled: false,
          passwordBreachCheckEnabled: false,
        } as never,
      },
    });

    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'never-existed@example.com' },
    });
    expect(req.statusCode).toBe(200);
    const data = req.json().data as { delivered: boolean; magicLinkToken: string | null };
    // Same enumeration-safe shape as forgot-password: nothing is leaked.
    expect(data.delivered).toBe(false);
    expect(data.magicLinkToken).toBeNull();
  });
  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await prisma.magicLinkToken.deleteMany({});
  });
});
