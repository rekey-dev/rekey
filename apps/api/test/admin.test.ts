/**
 * End-to-end tests for the bootstrap admin surface.
 *
 * Exercises the same flow documented in `docs/quickstart.md`:
 *   create tenant → create application → mint key → list/revoke.
 *
 * If `docs/quickstart.md` ever drifts from reality, these tests fail. That
 * is the contract.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('admin surface — end to end', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------- helpers ----------

  type ApiSuccess<T> = { success: true; data: T };
  type ApiFailure = { success: false; error: { code: string; message: string; fix?: string } };

  function asSuccess<T>(payload: ApiSuccess<T> | ApiFailure): ApiSuccess<T> {
    if (!payload.success) {
      throw new Error(`expected success, got ${JSON.stringify(payload.error)}`);
    }
    return payload;
  }

  // ---------- /health ----------

  it('GET /health/live → ok without touching a dependency', async () => {
    // Liveness must never report a dependency: a container healthcheck points
    // here, and restarting the API cannot fix a Postgres or Redis outage.
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'relipay-api' });
  });

  it('GET /health → ok, and reports which dependencies it checked', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; service: string; db: string; redis: string };
    // `status: 'ok'` is load-bearing — existing monitors and the compose
    // healthcheck match on it.
    expect(body.status).toBe('ok');
    expect(body.service).toBe('relipay-api');
    expect(body.db).toBe('ok');
    // Redis is absent in the test env, which is reported distinctly from down.
    expect(['ok', 'not_configured']).toContain(body.redis);
  });

  it('GET /health/ready → ready when DB is up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; db: string; redis: string };
    expect(body.status).toBe('ready');
    expect(body.db).toBe('ok');
    expect(['ok', 'not_configured']).toContain(body.redis);
  });

  // ---------- admin auth ----------

  it('rejects admin requests with no Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/tenants' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ADMIN_AUTH_MISSING');
    expect(res.json().error.fix).toBeTruthy();
  });

  it('rejects admin requests with the wrong key (constant-time)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenants',
      headers: { authorization: 'Bearer not-the-right-key-xxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ADMIN_AUTH_INVALID');
  });

  // ---------- full flow ----------

  it('walks the quickstart flow end to end', async () => {
    // 1. Create tenant
    const tenantRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'Acme', ownerEmail: 'ops@acme.example' },
    });
    expect(tenantRes.statusCode).toBe(201);
    const tenant = asSuccess<{ id: string; name: string }>(tenantRes.json()).data;
    expect(tenant.id).toMatch(/^[a-z0-9]{20,}$/);

    // 2. Create application
    const appRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: tenant.id, name: 'Acme Prod', slug: 'acme-prod' },
    });
    expect(appRes.statusCode).toBe(201);
    const application = asSuccess<{
      id: string;
      slug: string;
      publicKey: string;
      authConfig: { methods: string[] };
      billingConfig: { provider: string };
    }>(appRes.json()).data;
    expect(application.publicKey).toMatch(/^rp_pub_acme-prod_/);
    expect(application.authConfig.methods).toEqual(['password']);
    expect(application.billingConfig.provider).toBe('stripe');

    // 3. Mint API key
    const keyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${application.id}/api-keys`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'CI server', mode: 'live' },
    });
    expect(keyRes.statusCode).toBe(201);
    const created = asSuccess<{
      apiKey: { id: string; keyPrefix: string; scopes: string[] };
      rawKey: string;
      warning: string;
    }>(keyRes.json()).data;
    expect(created.rawKey).toMatch(/^rp_live_/);
    expect(created.apiKey.keyPrefix).toMatch(/^rp_live_/);
    expect(created.apiKey.scopes).toEqual(['*']);
    expect(created.warning).toContain('shown exactly once');
    // The hash MUST NOT be returned (regression guard).
    expect(created.apiKey).not.toHaveProperty('keyHash');

    // 4. List keys — also redacted
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${application.id}/api-keys`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = asSuccess<Array<Record<string, unknown>>>(listRes.json()).data;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('keyHash');

    // 5. Revoke is idempotent
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/applications/${application.id}/api-keys/${created.apiKey.id}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(asSuccess<{ revokedAt: string }>(revokeRes.json()).data.revokedAt).toBeTruthy();

    const revokeAgain = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/applications/${application.id}/api-keys/${created.apiKey.id}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(revokeAgain.statusCode).toBe(200); // still OK on second call

    // 6. List now excludes revoked key
    const listAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${application.id}/api-keys`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(asSuccess<unknown[]>(listAfter.json()).data).toHaveLength(0);
  });

  // ---------- error contracts ----------

  it('rejects an invalid slug with APPLICATION_SLUG_INVALID + a fix string', async () => {
    const tenant = asSuccess<{ id: string }>(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/tenants',
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { name: 'T', ownerEmail: 't@example.com' },
        })
      ).json(),
    ).data;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: tenant.id, name: 'X', slug: 'NOT VALID' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('APPLICATION_SLUG_INVALID');
    expect(res.json().error.fix).toBeTruthy();
  });

  it('rejects a duplicate slug with APPLICATION_SLUG_TAKEN', async () => {
    const tenant = asSuccess<{ id: string }>(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/tenants',
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { name: 'T', ownerEmail: 't@example.com' },
        })
      ).json(),
    ).data;

    const create = (): Promise<{ statusCode: number; json: () => { error: { code: string } } }> =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'X', slug: 'duplicated' },
      });

    expect((await create()).statusCode).toBe(201);
    const second = await create();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('APPLICATION_SLUG_TAKEN');
  });

  it('returns TENANT_NOT_FOUND when creating an app under a missing tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: 'no-such-tenant', name: 'X', slug: 'orphan-app' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TENANT_NOT_FOUND');
  });

  it('returns ROUTE_NOT_FOUND with a fix on unknown paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/wat' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
    expect(res.json().error.fix).toContain('/docs');
  });
});
