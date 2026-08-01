/**
 * Audit-3 / market-driven feature additions (2026-05-19):
 *
 *   - Magic-link sign-in: request → receive token (no transport in tests) →
 *     verify → session. Auto-creates user when sign-up is enabled.
 *   - HIBP breached-password refusal at sign-up (mocked via fetch stub).
 *   - Per-user account lockout after N failed sign-ins; lockout returns
 *     429 + Retry-After, then expires on the limiter key's TTL — and the
 *     operator end-user detail page reports the same lock the limiter is
 *     enforcing (it used to report "none" for every account; see the last
 *     test in this file).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { checkPasswordBreached } from '../src/lib/breached-password.js';
import { clearFailures, euLoginLockScope, LOGIN_POLICY } from '../src/lib/brute-force.js';

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

  async function endUserId(b: Bootstrapped, email: string): Promise<string> {
    const row = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: b.applicationId, email } },
      select: { id: true },
    });
    return row.id;
  }

  /** The payload the operator panel's end-user detail page renders. */
  async function operatorDetail(
    b: Bootstrapped,
    euid: string,
  ): Promise<{ failedSignInAttempts: number; lockedUntil: string | null }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data as { endUser: { failedSignInAttempts: number; lockedUntil: string | null } })
      .endUser;
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
    // Asserted through the operator surface rather than a column read: the
    // counter lives in the brute-force limiter, and the operator panel is the
    // only place a human ever sees it.
    const eu = await endUserId(b, 'reset-target@example.com');
    const detail = await operatorDetail(b, eu);
    expect(detail.failedSignInAttempts).toBe(0);
    expect(detail.lockedUntil).toBeNull();
  });

  it('a lockout expires on its own TTL — no lazy clear, no correct password refused', async () => {
    // This used to write `lockedUntil` in the past and check that sign-in
    // succeeded. That column had no reader, so the test proved nothing: it
    // would have passed against a permanently locked account. Lock expiry is
    // now the limiter key's TTL, so the honest way to test it is to move the
    // clock past the window.
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
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'expire-target@example.com', password: 'pw-one-two-three' },
    });

    for (let i = 0; i < LOGIN_POLICY.threshold; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'expire-target@example.com', password: 'wrong-' + i },
      });
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'expire-target@example.com', password: 'pw-one-two-three' },
    });
    expect(locked.statusCode).toBe(429);

    // Only Date is faked — setTimeout/argon2/Prisma I/O stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + (LOGIN_POLICY.lockSec + 1) * 1000);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'expire-target@example.com', password: 'pw-one-two-three' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- Lockout state as the OPERATOR sees it ----------

  it('the operator end-user detail reports the lock the limiter is actually enforcing', async () => {
    // The bug: `lockedUntil` / `failedSignInAttempts` were columns that nothing
    // had written since lockout moved to Redis, and the detail endpoint didn't
    // even select them — so the panel rendered "Lockout: none" for every
    // account, including one the API was actively refusing with 429. An
    // operator handling a "locked out of my account" report was shown the
    // opposite of the truth. Both fields now come from the limiter, so this
    // test drives REAL failed sign-ins and reads the operator surface back.
    const b = await bootstrap('lockout-operator-view');
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
    const email = 'operator-view-target@example.com';
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    const euid = await endUserId(b, email);

    const fresh = await operatorDetail(b, euid);
    expect(fresh.lockedUntil).toBeNull();
    expect(fresh.failedSignInAttempts).toBe(0);

    // Part-way to the threshold: the live counter is visible, still unlocked.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email, password: 'wrong-' + i },
      });
    }
    const partial = await operatorDetail(b, euid);
    expect(partial.failedSignInAttempts).toBe(3);
    expect(partial.lockedUntil).toBeNull();

    // Over the threshold: the API refuses sign-in...
    for (let i = 3; i < LOGIN_POLICY.threshold; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email, password: 'wrong-' + i },
      });
    }
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(refused.statusCode).toBe(429);

    // ...and the operator now sees that same lock. This is the assertion that
    // fails on the old code: it returned `undefined`, which the panel rendered
    // as "none".
    const lockedView = await operatorDetail(b, euid);
    expect(lockedView.lockedUntil).not.toBeNull();
    expect(new Date(lockedView.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
    // The retry-after the limiter quoted and the operator's expiry agree.
    const retryAfterSec = Number(refused.headers['retry-after']);
    const remainingSec = (new Date(lockedView.lockedUntil!).getTime() - Date.now()) / 1000;
    expect(Math.abs(remainingSec - retryAfterSec)).toBeLessThanOrEqual(2);
    // Locked ⇒ the counter was consumed setting the lock, so we report the
    // documented floor rather than an invented survivor count.
    expect(lockedView.failedSignInAttempts).toBe(LOGIN_POLICY.threshold);

    // The DSAR export publishes the same two fields (they are declared on the
    // shared-types `EndUserExportProfile`), so they must agree.
    // The DSAR document is served as a raw attachment, not in the `{data}`
    // envelope.
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}/export`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(exportRes.statusCode).toBe(200);
    const exported = JSON.parse(exportRes.body) as {
      endUser: { failedSignInAttempts: number; lockedUntil: string | null };
    };
    expect(exported.endUser.failedSignInAttempts).toBe(LOGIN_POLICY.threshold);
    expect(exported.endUser.lockedUntil).not.toBeNull();

    // A successful sign-in after the lock clears takes the badge with it.
    await clearFailures(euLoginLockScope(b.applicationId, email));
    const cleared = await operatorDetail(b, euid);
    expect(cleared.lockedUntil).toBeNull();
    expect(cleared.failedSignInAttempts).toBe(0);
  });

  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await prisma.magicLinkToken.deleteMany({});
  });
});
