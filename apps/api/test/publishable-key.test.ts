/**
 * Publishable-key auth — the browser credential for public-bootstrap routes.
 *
 * Load-bearing properties:
 *   - A publishable key (`rp_pub_…`) IS accepted on public-bootstrap routes
 *     (sign-up here), so a browser-only app can sign users in with no backend.
 *   - It is NEVER accepted on secret-only routes (GET /me) — the secret-key
 *     middleware rejects it, so a pub key can't structurally reach money or
 *     account-management surfaces.
 *   - The per-app CORS origin allowlist gates publishable requests.
 *   - Rotation is dual-key: the old key keeps working during the grace window,
 *     then hard-expires.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('Publishable-key auth', () => {
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
        payload: { tenantId: tenant.id, name: 'A', slug: 'pub-test' },
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

  function signUp(authKey: string, email: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${authKey}`, ...headers },
      payload: { email, password: 'correct-horse-battery' },
    });
  }

  // ---------- bootstrap route accepts the publishable key ----------

  it('201: sign-up succeeds with a publishable key (no backend needed)', async () => {
    const res = await signUp(publicKey, 'pub@example.com');
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { endUser: { applicationId: string } };
    expect(data.endUser.applicationId).toBe(applicationId);
  });

  it('201: sign-up still works with a secret key on the same route', async () => {
    const res = await signUp(liveKey, 'secret@example.com');
    expect(res.statusCode).toBe(201);
  });

  // ---------- secret-only route rejects the publishable key ----------

  it('401: a publishable key is rejected on a secret-only route (GET /me)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${publicKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_INVALID');
  });

  // ---------- unknown / malformed publishable key ----------

  it('401 PUBLISHABLE_KEY_INVALID for an unknown rp_pub_ key', async () => {
    const res = await signUp('rp_pub_pub-test_deadbeefdead', 'nope@example.com');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('PUBLISHABLE_KEY_INVALID');
  });

  // ---------- CORS origin allowlist ----------

  describe('with a CORS origin allowlist', () => {
    beforeEach(async () => {
      await prisma.application.update({
        where: { id: applicationId },
        data: { corsOrigins: ['https://allowed.example.com'] },
      });
    });

    it('200/201: matching Origin is allowed', async () => {
      const res = await signUp(publicKey, 'origin-ok@example.com', {
        origin: 'https://allowed.example.com',
      });
      expect(res.statusCode).toBe(201);
    });

    it('403 ORIGIN_NOT_ALLOWED: mismatched Origin', async () => {
      const res = await signUp(publicKey, 'origin-bad@example.com', {
        origin: 'https://evil.example.com',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('403 ORIGIN_NOT_ALLOWED: no Origin header at all', async () => {
      const res = await signUp(publicKey, 'origin-none@example.com');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('secret keys ignore the CORS allowlist (server-side, no Origin)', async () => {
      const res = await signUp(liveKey, 'secret-noorigin@example.com');
      expect(res.statusCode).toBe(201);
    });
  });

  // ---------- rotation with grace window ----------

  describe('rotation', () => {
    it('dual-key: after rotate, BOTH old and new keys work during the grace window', async () => {
      const oldKey = publicKey;
      const updated = await applicationsService.rotatePublicKey({ applicationId });
      expect(updated.publicKey).not.toBe(oldKey);
      expect(updated.previousPublicKey).toBe(oldKey);
      expect(updated.previousPublicKeyValidUntil).toBeTruthy();
      // New key works.
      expect((await signUp(updated.publicKey, 'new-key@example.com')).statusCode).toBe(201);
      // Old key still works within the grace window.
      expect((await signUp(oldKey, 'old-key@example.com')).statusCode).toBe(201);
    });

    it('after the grace window passes, the old key stops working', async () => {
      const oldKey = publicKey;
      await applicationsService.rotatePublicKey({ applicationId });
      // Fast-forward: push the deadline into the past.
      await prisma.application.update({
        where: { id: applicationId },
        data: { previousPublicKeyValidUntil: new Date(Date.now() - 1000) },
      });
      const res = await signUp(oldKey, 'expired-key@example.com');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('PUBLISHABLE_KEY_INVALID');
    });

    it('rejects a second rotation while a previous key is still in grace (no silent lockout)', async () => {
      await applicationsService.rotatePublicKey({ applicationId });
      await expect(applicationsService.rotatePublicKey({ applicationId })).rejects.toMatchObject({
        statusCode: 409,
        code: 'PUBLIC_KEY_ROTATION_IN_GRACE',
      });
    });

    it('force=true re-rotates during grace, dropping the oldest key', async () => {
      const oldest = publicKey;
      const first = await applicationsService.rotatePublicKey({ applicationId });
      const second = await applicationsService.rotatePublicKey({ applicationId, force: true });
      // The newest key works; the once-previous (first.publicKey) still works...
      expect((await signUp(second.publicKey, 'forced-new@example.com')).statusCode).toBe(201);
      expect((await signUp(first.publicKey, 'forced-prev@example.com')).statusCode).toBe(201);
      // ...but the original (dropped) key no longer authenticates.
      const dropped = await signUp(oldest, 'forced-dropped@example.com');
      expect(dropped.statusCode).toBe(401);
      expect(dropped.json().error.code).toBe('PUBLISHABLE_KEY_INVALID');
    });
  });
});
