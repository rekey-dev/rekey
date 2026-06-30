/**
 * /api/v1/me — the SDK's smoke-test endpoint and the first route gated by an
 * Application API key (rather than SUPER_ADMIN_KEY).
 *
 * The negative cases are the load-bearing ones: every kind of credential
 * mistake must produce a precise, code-stable rejection, and none of them
 * may leak hash/secret material.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('GET /api/v1/me — Application API key auth', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let publicKey: string;
  let liveKey: string;
  let liveKeyId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Bootstrap a tenant + application + one live API key for each test.
    // The per-file truncate in test/setup.ts ensures we start from clean state.
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
        payload: { tenantId: tenant.id, name: 'A', slug: 'me-test' },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'sdk', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string; apiKey: { id: string } });

    applicationId = application.id;
    publicKey = application.publicKey;
    liveKey = key.rawKey;
    liveKeyId = key.apiKey.id;
  });

  it('200 with the application DTO when given a valid live key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: applicationId,
      slug: 'me-test',
      publicKey,
    });
    // Hardening: the response must never carry secrets.
    expect(JSON.stringify(body)).not.toContain('keyHash');
    expect(JSON.stringify(body)).not.toContain(liveKey);
  });

  it('401 API_KEY_MISSING when the Authorization header is absent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_MISSING');
    expect(res.json().error.fix).toBeTruthy();
  });

  it('401 API_KEY_INVALID for a public key (browser-only credential)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${publicKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_INVALID');
    // The fix message points the operator at the right credential type.
    expect(res.json().error.fix).toContain('rp_live_');
  });

  it('401 API_KEY_INVALID for the bootstrap admin key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_INVALID');
  });

  it('401 API_KEY_INVALID for a well-formed-but-unknown rp_live_ key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: 'Bearer rp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_INVALID');
  });

  it('401 API_KEY_INVALID after the key is revoked', async () => {
    // Confirm it works first.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/me/',
          headers: { authorization: `Bearer ${liveKey}` },
        })
      ).statusCode,
    ).toBe(200);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/applications/${applicationId}/api-keys/${liveKeyId}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_INVALID');
  });

  it('401 API_KEY_INVALID when the key has expired', async () => {
    // Backdate expires_at directly. Sidesteps having to wait or freeze time —
    // we trust the verify() path's `expiresAt < new Date()` check.
    await prisma.apiKey.update({
      where: { id: liveKeyId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_INVALID');
  });

  it('updates lastUsedAt on a successful call (eventually)', async () => {
    const before = await prisma.apiKey.findUniqueOrThrow({ where: { id: liveKeyId } });
    expect(before.lastUsedAt).toBeNull();

    await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${liveKey}` },
    });

    // The update is fire-and-forget, so it may race the response. Poll briefly.
    let lastUsedAt: Date | null = null;
    for (let i = 0; i < 10; i++) {
      const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: liveKeyId } });
      if (row.lastUsedAt !== null) {
        lastUsedAt = row.lastUsedAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(lastUsedAt).not.toBeNull();
  });
});
