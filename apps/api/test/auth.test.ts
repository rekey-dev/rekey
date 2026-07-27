/**
 * EndUser auth — sign-up, sign-in, users/me, cross-application guard.
 *
 * The cross-app guard is the load-bearing assertion: a JWT issued by
 * Application A must NOT be acceptable when presented through a secret
 * key for Application B. Without this property, Rekey's multi-tenancy
 * leaks at the user-data layer.
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

describe('EndUser auth — POST /sign-up, POST /sign-in, GET /users/me', () => {
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

  async function bootstrapApplication(slug: string): Promise<BootstrappedApp> {
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
    appA = await bootstrapApplication('app-a');
    appB = await bootstrapApplication('app-b');
  });

  // ---------- sign-up ----------

  it('signs up a new user and returns a JWT + redacted user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'alice@example.com', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      endUser: Record<string, unknown>;
      accessToken: string;
      accessTokenExpiresAt: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
    };
    expect(data.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // JWT three-part
    expect(data.refreshToken.length).toBeGreaterThanOrEqual(32);
    // Access expires before refresh (15min vs 30 days).
    expect(new Date(data.accessTokenExpiresAt).getTime()).toBeLessThan(
      new Date(data.refreshTokenExpiresAt).getTime(),
    );
    expect(data.endUser).toMatchObject({
      email: 'alice@example.com',
      applicationId: appA.applicationId,
    });
    expect(data.endUser).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(data)).not.toContain('passwordHash');
  });

  it('lowercases email on sign-up so duplicates collide regardless of case', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'Alice@Example.com', password: 'pw-one-two-three' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'ALICE@example.COM', password: 'pw-one-two-three' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('allows the same email across different Applications', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'shared@example.com', password: 'pw-one-two-three' },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appB.liveKey}` },
      payload: { email: 'shared@example.com', password: 'pw-one-two-three' },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    // Different ids — they're separate users.
    expect(a.json().data.endUser.id).not.toBe(b.json().data.endUser.id);
  });

  it('rejects passwords shorter than authConfig.passwordMinLength', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'short@example.com', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PASSWORD_TOO_SHORT');
    expect(res.json().error.fix).toContain('8');
  });

  it('rejects sign-up when password is not in the Application authConfig.methods', async () => {
    // Switch app A's config to oauth-only by writing it directly. (No admin route
    // for this yet — when one ships, swap to that.)
    await prisma.application.update({
      where: { id: appA.applicationId },
      data: {
        authConfig: {
          methods: ['google'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: false,
        } as never,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'oauth-only@example.com', password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('AUTH_METHOD_DISABLED');
  });

  // ---------- sign-in ----------

  it('signs an existing user in with the correct password', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'bob@example.com', password: 'pw-one-two-three' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'bob@example.com', password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.accessToken).toBeTruthy();
    expect(res.json().data.refreshToken).toBeTruthy();
  });

  it('returns INVALID_CREDENTIALS for wrong password (no enumeration)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'carol@example.com', password: 'pw-one-two-three' },
    });
    const wrongPw = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'carol@example.com', password: 'WRONG' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongPw.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns INVALID_CREDENTIALS for unknown email (same code as wrong password)', async () => {
    const noUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'ghost@example.com', password: 'pw-one-two-three' },
    });
    expect(noUser.statusCode).toBe(401);
    expect(noUser.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  // ---------- /users/me ----------

  it('returns the current EndUser when given a valid token + matching key', async () => {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'dan@example.com', password: 'pw-one-two-three' },
    });
    const { accessToken, endUser } = signUp.json().data as {
      accessToken: string;
      endUser: { id: string; email: string };
    };

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${appA.liveKey}`,
        'x-rekey-user-token': accessToken,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: endUser.id, email: 'dan@example.com' });
    expect(res.json().data).not.toHaveProperty('passwordHash');
  });

  it('401 USER_TOKEN_MISSING when the user token header is absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${appA.liveKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_MISSING');
  });

  it('401 USER_TOKEN_INVALID for a malformed JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${appA.liveKey}`,
        'x-rekey-user-token': 'not.a.jwt',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
  });

  it('CROSS-APP GUARD: rejects a JWT issued by a different Application', async () => {
    // Mint a token in app A …
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { email: 'eve@example.com', password: 'pw-one-two-three' },
    });
    const { accessToken } = signUp.json().data as { accessToken: string };

    // … then present it through app B's secret key.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${appB.liveKey}`,
        'x-rekey-user-token': accessToken,
      },
    });
    expect(res.statusCode).toBe(401);
    // End-user JWTs are now signed with a per-app derived key
    // (HMAC(JWT_SECRET, appId:generation)), so a token minted for app A fails
    // signature verification under app B's key — rejected as USER_TOKEN_INVALID
    // before the claim-based WRONG_APPLICATION check is even reached. The
    // isolation is now cryptographic, not just a claim comparison.
    expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
  });
});
