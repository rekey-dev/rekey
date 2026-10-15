/**
 * Per-account lockout after repeated failed sign-ins: the lock answers 429 with
 * Retry-After, a successful sign-in clears the counter, the lock expires on the
 * limiter key's own TTL, and the operator's end-user detail reports the same
 * lock the limiter is enforcing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clearFailures, euLoginLockScope, LOGIN_POLICY } from '../src/lib/brute-force.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('account lockout after failed sign-ins', () => {
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

  it('11th failed sign-in triggers 429 TOO_MANY_FAILED_ATTEMPTS with Retry-After', async () => {
    const b = await bootstrap('lockout');
    // Disable HIBP for this test app, fast sign-ups during the lockout drill.
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

    // 11th attempt, even with the CORRECT password, is locked out.
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

  it('a lockout expires on its own TTL, no lazy clear, no correct password refused', async () => {
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

    // Only Date is faked, setTimeout/argon2/Prisma I/O stay real.
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

  it('the operator end-user detail reports the lock the limiter is actually enforcing', async () => {
    // The bug: `lockedUntil` / `failedSignInAttempts` were columns that nothing
    // had written since lockout moved to Redis, and the detail endpoint didn't
    // even select them, so the panel rendered "Lockout: none" for every
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
