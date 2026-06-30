/**
 * Audit-3 / market-driven feature additions (2026-05-19):
 *
 *   - Magic-link sign-in: request → receive token (no transport in tests) →
 *     verify → session. Auto-creates user when sign-up is enabled.
 *   - HIBP breached-password refusal at sign-up (mocked via fetch stub).
 *   - Per-user account lockout after N failed sign-ins; lockout returns
 *     429 + Retry-After, then expires lazily.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { checkPasswordBreached } from '../src/lib/breached-password.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('Audit-3 feature additions', () => {
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
      // Direct DB mutation is fine here — the API surface for editing
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

  // ---------- Magic-link sign-in ----------

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

  // ---------- HIBP breach-check ----------

  it('HIBP check via mocked fetch flags `password`', async () => {
    // The string "password" has SHA-1 prefix 5BAA6 and suffix
    // 1E4C9B93F3F0682250B6CF8331B7EE68FD8. Build a minimal range response.
    const fakeFetch = async (): Promise<Response> => {
      return new Response(
        '1E4C9B93F3F0682250B6CF8331B7EE68FD8:5567145\r\n' +
          '0000000000000000000000000000000000000000:1\r\n',
        { status: 200, headers: { 'content-type': 'text/plain' } },
      );
    };
    const result = await checkPasswordBreached('password', fakeFetch as unknown as typeof fetch);
    expect(result.breached).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.contacted).toBe(true);
  });

  it('HIBP check fails open on network error', async () => {
    const erroringFetch = async (): Promise<Response> => {
      throw new Error('network down');
    };
    const result = await checkPasswordBreached(
      'whatever',
      erroringFetch as unknown as typeof fetch,
    );
    expect(result.breached).toBe(false);
    expect(result.contacted).toBe(false);
  });

  // ---------- Account lockout ----------

  it('11th failed sign-in triggers 429 TOO_MANY_FAILED_ATTEMPTS with Retry-After', async () => {
    const b = await bootstrap('lockout');
    // Disable HIBP for this test app — fast sign-ups during the lockout drill.
    await prisma.application.update({
      where: { id: b.applicationId },
      data: {
        authConfig: {
          methods: ['password'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: false,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
        } as never,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'lockout-target@example.com', password: 'pw-one-two-three' },
    });

    // 10 failures lock the user.
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'lockout-target@example.com', password: 'wrong-' + i },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    }

    // 11th attempt — even with the CORRECT password — is locked out.
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'lockout-target@example.com', password: 'pw-one-two-three' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('TOO_MANY_FAILED_ATTEMPTS');
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('successful sign-in clears the failed-attempts counter', async () => {
    const b = await bootstrap('lockout-reset');
    await prisma.application.update({
      where: { id: b.applicationId },
      data: {
        authConfig: {
          methods: ['password'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: false,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
        } as never,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'reset-target@example.com', password: 'pw-one-two-three' },
    });

    // 3 failures, then succeed.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'reset-target@example.com', password: 'no' },
      });
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'reset-target@example.com', password: 'pw-one-two-three' },
    });
    expect(ok.statusCode).toBe(200);
    const u = await prisma.endUser.findUniqueOrThrow({
      where: {
        applicationId_email: {
          applicationId: b.applicationId,
          email: 'reset-target@example.com',
        },
      },
    });
    expect(u.failedSignInAttempts).toBe(0);
    expect(u.lockedUntil).toBeNull();
  });

  it('expired lockout is cleared lazily on next failed attempt', async () => {
    const b = await bootstrap('lockout-expire');
    await prisma.application.update({
      where: { id: b.applicationId },
      data: {
        authConfig: {
          methods: ['password'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: false,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
        } as never,
      },
    });
    const su = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'expire-target@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { endUser: { id: string } });

    // Force a lockout state with expiry in the past — simulates the
    // 15-minute window elapsing without writing a wall-clock waiter.
    await prisma.endUser.update({
      where: { id: su.endUser.id },
      data: {
        failedSignInAttempts: 0,
        lockedUntil: new Date(Date.now() - 1000),
      },
    });

    // Correct password should now succeed; the expired lockout is
    // cleared on the way through.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'expire-target@example.com', password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await prisma.magicLinkToken.deleteMany({});
  });
});
