/**
 * Refresh-token rotation, replay protection, sign-out, cross-app guard.
 *
 * The replay-protection assertion is the load-bearing one — a refresh
 * token is single-use. Reusing it should always be detected and rejected
 * (REFRESH_TOKEN_REUSED), because reuse strongly implies the token was
 * leaked.
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

describe('POST /auth/refresh + /auth/sign-out', () => {
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
    email: string,
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
    return { accessToken: data.accessToken, refreshToken: data.refreshToken, endUserId: data.endUser.id };
  }

  beforeEach(async () => {
    appA = await bootstrap('refresh-a');
    appB = await bootstrap('refresh-b');
  });

  it('exchanges a refresh token for a fresh pair (rotation)', async () => {
    const { refreshToken: original } = await signUp(appA, 'rot@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: original },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { accessToken: string; refreshToken: string };
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).not.toBe(original); // rotation, not just reissue
  });

  it('REPLAY GUARD: a once-used refresh token returns REFRESH_TOKEN_REUSED', async () => {
    const { refreshToken: original } = await signUp(appA, 'replay@example.com');

    // First use succeeds.
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: original },
    });
    expect(first.statusCode).toBe(200);

    // Second use of the same original token must fail.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: original },
    });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('FAMILY REVOCATION: reuse-detection revokes every active refresh for the user', async () => {
    // Issue an initial token, rotate once to get a live replacement, then
    // replay the original. Reuse-detection should revoke the replacement
    // too — leaving every refresh for this user dead.
    const { refreshToken: original, endUserId } = await signUp(appA, 'family@example.com');
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: original },
    });
    const replacement = (r1.json().data as { refreshToken: string }).refreshToken;

    // Replay the original — strong compromise signal.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: original },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');

    // The live replacement must now also be rejected — family revocation. It
    // reports REVOKED rather than REUSED because *it* was never replayed: the
    // family kill revoked it outright, so `replacedById` is null. What matters
    // is that it is dead, which the DB invariant below pins.
    const afterFamily = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: replacement },
    });
    expect(afterFamily.statusCode).toBe(401);
    expect(afterFamily.json().error.code).toBe('REFRESH_TOKEN_REVOKED');

    // DB invariant: every refresh row for this user is revoked.
    const live = await prisma.refreshToken.count({
      where: { endUserId, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('chains rotations via replacedById so the audit trail is walkable', async () => {
    const { refreshToken: t1, endUserId } = await signUp(appA, 'chain@example.com');

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: t1 },
    });
    const t2 = (r1.json().data as { refreshToken: string }).refreshToken;

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: t2 },
    });
    expect(r2.statusCode).toBe(200);

    // Walk the chain in DB.
    const tokens = await prisma.refreshToken.findMany({
      where: { endUserId },
      orderBy: { createdAt: 'asc' },
    });
    expect(tokens).toHaveLength(3);
    expect(tokens[0]!.revokedAt).not.toBeNull();
    expect(tokens[0]!.replacedById).toBe(tokens[1]!.id);
    expect(tokens[1]!.revokedAt).not.toBeNull();
    expect(tokens[1]!.replacedById).toBe(tokens[2]!.id);
    expect(tokens[2]!.revokedAt).toBeNull();
  });

  it('rejects refresh tokens that have expired', async () => {
    const { refreshToken } = await signUp(appA, 'expired@example.com');
    // Backdate expiry directly.
    await prisma.refreshToken.updateMany({
      where: { applicationId: appA.applicationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('REFRESH_TOKEN_EXPIRED');
  });

  it('rejects unknown refresh tokens with REFRESH_TOKEN_INVALID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: 'totally-fake-token-value' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('CROSS-APP GUARD: a refresh issued under app A is rejected via app B\'s key', async () => {
    const { refreshToken } = await signUp(appA, 'cross@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appB.liveKey}` },
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('REFRESH_TOKEN_WRONG_APPLICATION');
  });

  it('sign-out revokes the refresh token; subsequent refresh attempts fail', async () => {
    const { refreshToken } = await signUp(appA, 'signout@example.com');

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken },
    });
    expect(out.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
    // Sign-out is a DELIBERATE revocation (`replacedById === null`), so it is
    // REVOKED, not REUSED — and critically it does not revoke the user's other
    // sessions. Reuse of a *rotated* token is the compromise signal and still
    // burns the whole chain; see the REPLAY GUARD cases above.
    expect(['REFRESH_TOKEN_REVOKED', 'REFRESH_TOKEN_INVALID']).toContain(
      res.json().error.code,
    );
  });

  it('sign-out is idempotent — unknown token returns 200, no enumeration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { refreshToken: 'definitely-never-issued' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ signedOut: true });
  });
});
