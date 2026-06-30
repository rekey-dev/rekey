/**
 * Per-request access log (api_request_logs).
 *
 * Covers the global onResponse hook + the two read endpoints + the pruner:
 *   - The hook records one row per response, fire-and-forget, with identity
 *     resolved AFTER auth middleware (applicationId/tenantId for API-key
 *     traffic; operatorUserId/tenantId for operator traffic; null otherwise).
 *   - GET /tenant/applications/:id/requests — per-app, OWNER/ADMIN, tenant-scoped.
 *   - GET /tenant/auth/requests — the calling operator's own requests.
 *   - pruneApiRequestLogs caps each app/operator to the last N rows.
 *
 * The insert is intentionally async (the response is already flushed when the
 * hook fires), so assertions poll the table with `waitForCount` rather than
 * reading immediately after inject().
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { flushApiRequestLogs, pruneApiRequestLogs } from '../src/lib/request-log.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface BootstrappedApp {
  applicationId: string;
  tenantId: string;
  liveKey: string;
}

describe('API request log', () => {
  let app: FastifyInstance;

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
    return { applicationId: application.id, tenantId: tenant.id, liveKey: key.rawKey };
  }

  /** Sign up a fresh operator + workspace; returns token + ids. */
  async function bootstrapOperator(slug: string): Promise<{
    accessToken: string;
    tenantUserId: string;
    tenantId: string;
  }> {
    const data = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-long-enough',
          workspaceName: `WS-${slug}`,
        },
      })
      .then((r) => r.json().data as {
        accessToken: string;
        user: { id: string };
        activeTenantId: string;
      });
    return {
      accessToken: data.accessToken,
      tenantUserId: data.user.id,
      tenantId: data.activeTenantId,
    };
  }

  beforeEach(async () => {
    // setup.ts truncates api_request_logs before each test, so every case
    // starts from an empty log.
  });

  // ---------- hook records API-key traffic ----------

  it('records an API-key request with applicationId + tenantId, operator null', async () => {
    const a = await bootstrap('reqlog-key');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${a.liveKey}` },
      payload: { email: 'enduser@example.com', password: 'pw-long-enough' },
    });
    expect(res.statusCode).toBeLessThan(500);

    await flushApiRequestLogs();
    const row = await prisma.apiRequestLog.findFirst({
      where: { applicationId: a.applicationId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).toBeTruthy();
    expect(row!.method).toBe('POST');
    expect(row!.routePath).toBe('/api/v1/auth/sign-up');
    // tenantId is enriched from the Application even though API-key auth
    // doesn't set req.tenantId.
    expect(row!.tenantId).toBe(a.tenantId);
    expect(row!.operatorUserId).toBeNull();
    expect(row!.statusCode).toBe(res.statusCode);
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ---------- hook records operator traffic ----------

  it('records an operator request with operatorUserId + tenantId, application null', async () => {
    const op = await bootstrapOperator('reqlog-op');
    await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/me',
      headers: { authorization: `Bearer ${op.accessToken}` },
    });

    await flushApiRequestLogs();
    const row = await prisma.apiRequestLog.findFirst({
      where: { operatorUserId: op.tenantUserId, routePath: '/api/v1/tenant/auth/me' },
    });
    expect(row).toBeTruthy();
    expect(row!.applicationId).toBeNull();
    expect(row!.tenantId).toBe(op.tenantId);
    expect(row!.method).toBe('GET');
  });

  // ---------- per-app read endpoint ----------

  it('GET /tenant/applications/:id/requests returns this app\'s requests', async () => {
    const a = await bootstrap('reqlog-appread');
    const op = await bootstrapOperator('reqlog-appread');
    // Move the operator's active workspace to the app's tenant by making the
    // operator an owner there is heavy; instead bootstrap the app under the
    // operator's own workspace via the tenant API.
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { name: 'owned', slug: `owned-${Date.now()}` },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });

    // Mint a live key for the owned app + drive one API-key request through it.
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${created.id}/api-keys`,
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key.rawKey}` },
      payload: { email: 'owned-enduser@example.com', password: 'pw-long-enough' },
    });
    await flushApiRequestLogs();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${created.id}/requests`,
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { requests } = res.json().data as {
      requests: Array<{ applicationId: string | null; routePath: string }>;
    };
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.every((r) => r.applicationId === created.id)).toBe(true);
    expect(requests.some((r) => r.routePath === '/api/v1/auth/sign-up')).toBe(true);
    // unused, keeps the bootstrap app helper exercised
    expect(a.applicationId).toBeTruthy();
  });

  it('GET /tenant/applications/:id/requests refuses an app in another workspace (404)', async () => {
    const op = await bootstrapOperator('reqlog-cross');
    const other = await bootstrap('reqlog-cross-other');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${other.applicationId}/requests`,
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('GET /tenant/applications/:id/requests requires a session (401)', async () => {
    const a = await bootstrap('reqlog-noauth');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${a.applicationId}/requests`,
    });
    expect(res.statusCode).toBe(401);
  });

  // ---------- per-operator read endpoint + pagination ----------

  it('GET /tenant/auth/requests returns the operator\'s own requests, paginated', async () => {
    const op = await bootstrapOperator('reqlog-self');
    // Drive a few operator requests.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/auth/me',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
    }
    await flushApiRequestLogs();

    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/requests?limit=2',
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    expect(page1.statusCode).toBe(200);
    const r1 = (page1.json().data as { requests: unknown[] }).requests;
    expect(r1.length).toBe(2);

    const page2 = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/requests?limit=2&offset=2',
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    const r2 = (page2.json().data as { requests: Array<{ operatorUserId: string | null }> })
      .requests;
    expect(r2.length).toBeGreaterThanOrEqual(1);
    expect(r2.every((r) => r.operatorUserId === op.tenantUserId)).toBe(true);
  });

  // ---------- pruner ----------

  it('pruneApiRequestLogs caps an application to the last N rows, keeping newest', async () => {
    const appId = 'prune-app-id';
    const base = Date.now();
    // 10 rows, increasing createdAt so "newest" is deterministic.
    for (let i = 0; i < 10; i++) {
      await prisma.apiRequestLog.create({
        data: {
          method: 'GET',
          routePath: `/p/${i}`,
          statusCode: 200,
          durationMs: 1,
          applicationId: appId,
          createdAt: new Date(base + i * 1000),
        },
      });
    }
    const deleted = await pruneApiRequestLogs(4);
    expect(deleted).toBeGreaterThanOrEqual(6);

    const remaining = await prisma.apiRequestLog.findMany({
      where: { applicationId: appId },
      orderBy: { createdAt: 'desc' },
    });
    expect(remaining.length).toBe(4);
    // The 4 newest are /p/9../p/6.
    expect(remaining.map((r) => r.routePath)).toEqual(['/p/9', '/p/8', '/p/7', '/p/6']);
  });

  it('pruneApiRequestLogs also caps the anonymous bucket', async () => {
    for (let i = 0; i < 6; i++) {
      await prisma.apiRequestLog.create({
        data: {
          method: 'GET',
          routePath: `/anon/${i}`,
          statusCode: 404,
          durationMs: 1,
          // application + operator null → anonymous bucket
        },
      });
    }
    await pruneApiRequestLogs(2);
    const remaining = await prisma.apiRequestLog.count({
      where: { applicationId: null, operatorUserId: null },
    });
    expect(remaining).toBe(2);
  });
});
