/**
 * Password reset, change, sign-out-everywhere — the "auth completeness"
 * surface. Each test exercises an HTTP path end-to-end, including the
 * cross-application guards and the "revoke all refresh tokens on
 * password change" semantics that the docs promise.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface BootstrappedApp {
  applicationId: string;
  liveKey: string;
}

describe('password flows + sign-out-everywhere', () => {
  let app: FastifyInstance;
  let appA: BootstrappedApp;
  let appB: BootstrappedApp;

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

  async function signUp(
    bootstrapped: BootstrappedApp,
    email = 'pwf@example.com',
  ): Promise<{ accessToken: string; refreshToken: string; endUserId: string }> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${bootstrapped.liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    const data = r.json().data as {
      accessToken: string;
      refreshToken: string;
      endUser: { id: string };
    };
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      endUserId: data.endUser.id,
    };
  }

  beforeEach(async () => {
    appA = await bootstrap('pwf-a');
    appB = await bootstrap('pwf-b');
  });

  // ---------- forgot-password ----------

  it('forgot-password issues a token for an existing user', async () => {
    await signUp(appA, 'reset@example.com');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'reset@example.com' },
    });
    expect(r.statusCode).toBe(200);
    const data = r.json().data as { delivered: boolean; resetToken: string | null };
    expect(data.delivered).toBe(true);
    expect(data.resetToken).toBeTruthy();
    expect(data.resetToken!.length).toBeGreaterThanOrEqual(32);
  });

  it('forgot-password does NOT enumerate — same shape, no token, for unknown email', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'no-such-user@example.com' },
    });
    expect(r.statusCode).toBe(200);
    // `delivered` is the enumeration discriminator. `emailSent` was added
    // with the email-pipeline phase; this test doesn't configure transport,
    // so it stays false.
    expect(r.json().data).toEqual({
      delivered: false,
      emailSent: false,
      resetToken: null,
    });
  });

  // ---------- reset-password ----------

  it('reset-password consumes the token, sets the new password, kills sessions', async () => {
    const { refreshToken } = await signUp(appA, 'doreset@example.com');

    const reset = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${appA.liveKey}` },
        payload: { email: 'doreset@example.com' },
      })
      .then((r) => r.json().data as { resetToken: string });

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { token: reset.resetToken, newPassword: 'brand-new-passphrase' },
    });
    expect(r.statusCode).toBe(200);

    // Old refresh token must be revoked.
    const refreshAfter = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken },
    });
    expect(refreshAfter.statusCode).toBe(401);

    // Sign-in with the new password must work; old must not.
    const oldPw = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'doreset@example.com', password: 'pw-one-two-three' },
    });
    expect(oldPw.statusCode).toBe(401);

    const newPw = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'doreset@example.com', password: 'brand-new-passphrase' },
    });
    expect(newPw.statusCode).toBe(200);
  });

  it('reset-password rejects a re-used token with PASSWORD_RESET_TOKEN_USED', async () => {
    await signUp(appA, 'replay@example.com');
    const { resetToken } = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${appA.liveKey}` },
        payload: { email: 'replay@example.com' },
      })
      .then((r) => r.json().data as { resetToken: string });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { token: resetToken, newPassword: 'first-new-pw' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { token: resetToken, newPassword: 'second-new-pw' },
    });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('PASSWORD_RESET_TOKEN_USED');
  });

  it('reset-password rejects an expired token with PASSWORD_RESET_TOKEN_EXPIRED', async () => {
    await signUp(appA, 'exp@example.com');
    const { resetToken } = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${appA.liveKey}` },
        payload: { email: 'exp@example.com' },
      })
      .then((r) => r.json().data as { resetToken: string });
    await prisma.passwordResetToken.updateMany({
      where: { applicationId: appA.applicationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { token: resetToken, newPassword: 'brand-new-passphrase' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('PASSWORD_RESET_TOKEN_EXPIRED');
  });

  it('CROSS-APP GUARD: reset token from app A rejected via app B key', async () => {
    await signUp(appA, 'xa@example.com');
    const { resetToken } = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${appA.liveKey}` },
        payload: { email: 'xa@example.com' },
      })
      .then((r) => r.json().data as { resetToken: string });

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { authorization: `Bearer ${appB.liveKey}` },
      payload: { token: resetToken, newPassword: 'brand-new-passphrase' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('PASSWORD_RESET_TOKEN_WRONG_APPLICATION');
  });

  it('reset-password enforces passwordMinLength', async () => {
    await signUp(appA, 'short@example.com');
    const { resetToken } = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${appA.liveKey}` },
        payload: { email: 'short@example.com' },
      })
      .then((r) => r.json().data as { resetToken: string });

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { token: resetToken, newPassword: 'x' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('PASSWORD_TOO_SHORT');
  });

  // ---------- change-password ----------

  it('change-password requires the current password', async () => {
    const { accessToken } = await signUp(appA, 'cpw@example.com');
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${appA.liveKey}`, 'x-relipay-user-token': accessToken },
      payload: { currentPassword: 'WRONG', newPassword: 'brand-new-passphrase' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('change-password rotates the password + revokes other refresh tokens', async () => {
    const { accessToken, refreshToken } = await signUp(appA, 'changes@example.com');

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${appA.liveKey}`, 'x-relipay-user-token': accessToken },
      payload: { currentPassword: 'pw-one-two-three', newPassword: 'fresh-passphrase' },
    });
    expect(r.statusCode).toBe(200);

    // Old refresh dead.
    const refreshDead = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken },
    });
    expect(refreshDead.statusCode).toBe(401);

    // Sign-in with the new password works.
    const newPw = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'changes@example.com', password: 'fresh-passphrase' },
    });
    expect(newPw.statusCode).toBe(200);
  });

  // ---------- sign-out-everywhere ----------

  it('sign-out-everywhere revokes every refresh token for the calling user', async () => {
    const { accessToken, refreshToken, endUserId } = await signUp(appA, 'sou@example.com');
    // Issue a few extra refresh tokens by signing in repeatedly.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${appA.liveKey}` },
        payload: { email: 'sou@example.com', password: 'pw-one-two-three' },
      });
    }

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out-everywhere',
      headers: { authorization: `Bearer ${appA.liveKey}`, 'x-relipay-user-token': accessToken },
    });
    expect(r.statusCode).toBe(200);
    const data = r.json().data as { revokedCount: number };
    expect(data.revokedCount).toBeGreaterThanOrEqual(4);

    // Original refresh dead.
    const refreshDead = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken },
    });
    expect(refreshDead.statusCode).toBe(401);

    const remaining = await prisma.refreshToken.count({
      where: { endUserId, revokedAt: null },
    });
    expect(remaining).toBe(0);
  });
});
