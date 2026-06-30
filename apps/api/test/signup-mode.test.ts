/**
 * Three-way end-user sign-up policy (`authConfig.signupMode`).
 *
 * Load-bearing properties:
 *   - `public` (default) — both the publishable and the secret key may create
 *     end-users. Existing behaviour, must stay unchanged.
 *   - `secret_only` — ONLY a server-side secret key may create end-users; the
 *     publishable key is refused with `SIGNUP_REQUIRES_SECRET_KEY`. The guard
 *     covers every creation entry: password sign-up, magic-link, OAuth-first.
 *     A publishable key can still sign EXISTING users in.
 *   - `invite_only` — no public sign-up at all; both kinds are refused with
 *     `SIGNUP_DISABLED`.
 *   - Back-compat: the legacy `signupEnabled` boolean still drives the mode
 *     both directions (`false` ⇔ `invite_only`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuthConfigSchema } from '@relipay/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('Sign-up mode (public / secret_only / invite_only)', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let publicKey: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'T', ownerEmail: 't@example.com' },
      })
      .then((r) => r.json().data as { id: string });

    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'A', slug: 'signup-mode' },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'sdk', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    applicationId = application.id;
    publicKey = application.publicKey;
    liveKey = key.rawKey;
  });

  function signUp(authKey: string, email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${authKey}` },
      payload: { email, password: 'correct-horse-battery' },
    });
  }

  function magicLinkRequest(authKey: string, email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${authKey}` },
      payload: { email },
    });
  }

  // ---------- public (default) — unchanged ----------

  describe('public (default)', () => {
    it('201: publishable key may create a user', async () => {
      expect((await signUp(publicKey, 'pub-public@example.com')).statusCode).toBe(201);
    });

    it('201: secret key may create a user', async () => {
      expect((await signUp(liveKey, 'secret-public@example.com')).statusCode).toBe(201);
    });
  });

  // ---------- secret_only ----------

  describe('secret_only', () => {
    beforeEach(async () => {
      await applicationsService.updateAuthConfig({
        applicationId,
        patch: { signupMode: 'secret_only', methods: ['password', 'magic_link'] },
      });
    });

    it('403 SIGNUP_REQUIRES_SECRET_KEY: publishable key cannot create a user', async () => {
      const res = await signUp(publicKey, 'pub-blocked@example.com');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SIGNUP_REQUIRES_SECRET_KEY');
    });

    it('201: secret key may still create a user', async () => {
      expect((await signUp(liveKey, 'secret-ok@example.com')).statusCode).toBe(201);
    });

    it('publishable magic-link for a NEW email is silently refused (enumeration-safe)', async () => {
      const res = await magicLinkRequest(publicKey, 'pub-ml-new@example.com');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ delivered: false, magicLinkToken: null });
      // No user was created.
      const u = await prisma.endUser.findUnique({
        where: { applicationId_email: { applicationId, email: 'pub-ml-new@example.com' } },
      });
      expect(u).toBeNull();
    });

    it('publishable key can still SIGN IN an existing user', async () => {
      // Create via secret key first, then sign in with the publishable key.
      expect((await signUp(liveKey, 'existing@example.com')).statusCode).toBe(201);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { email: 'existing@example.com', password: 'correct-horse-battery' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ---------- invite_only ----------

  describe('invite_only', () => {
    beforeEach(async () => {
      await applicationsService.updateAuthConfig({
        applicationId,
        patch: { signupMode: 'invite_only' },
      });
    });

    it('403 SIGNUP_DISABLED: publishable key blocked', async () => {
      const res = await signUp(publicKey, 'inv-pub@example.com');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SIGNUP_DISABLED');
    });

    it('403 SIGNUP_DISABLED: secret key blocked too', async () => {
      const res = await signUp(liveKey, 'inv-secret@example.com');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SIGNUP_DISABLED');
    });
  });

  // ---------- back-compat with the legacy boolean ----------

  describe('legacy signupEnabled back-compat', () => {
    it('PATCH signupEnabled=false ⇒ invite_only behaviour', async () => {
      await applicationsService.updateAuthConfig({
        applicationId,
        patch: { signupEnabled: false },
      });
      const fresh = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(AuthConfigSchema.parse(fresh.authConfig).signupMode).toBe('invite_only');
      expect((await signUp(liveKey, 'legacy-off@example.com')).statusCode).toBe(403);
    });

    it('reading old data with only signupEnabled=false derives invite_only', () => {
      const parsed = AuthConfigSchema.parse({
        methods: ['password'],
        redirectUrls: [],
        signupEnabled: false,
      });
      expect(parsed.signupMode).toBe('invite_only');
      expect(parsed.signupEnabled).toBe(false);
    });

    it('secret_only still reports signupEnabled=true (signup IS enabled)', () => {
      const parsed = AuthConfigSchema.parse({
        methods: ['password'],
        redirectUrls: [],
        signupMode: 'secret_only',
      });
      expect(parsed.signupEnabled).toBe(true);
    });
  });
});
