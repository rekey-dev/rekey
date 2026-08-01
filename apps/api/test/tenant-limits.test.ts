/**
 * Per-workspace (Tenant) resource limits.
 *
 * The load-bearing assertions here are the two that make this safe to ship to
 * an auth product:
 *   1. A workspace with no limit set is UNLIMITED — every pre-existing
 *      deployment must be unaffected by the column existing.
 *   2. A workspace OVER its limit still signs its existing end-users in.
 *      Quota gates creation, never authentication.
 *
 * Plus the two that make it a real quota rather than a suggestion: the count
 * is summed across every Application in the workspace, and only a
 * SUPER_ADMIN_KEY holder can move the number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PASSWORD = 'correct-horse-battery';

interface Workspace {
  tenantId: string;
  applicationId: string;
  liveKey: string;
}

describe('Tenant limits — maxActiveEndUsers', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------- helpers ----------

  const adminAuth = { authorization: `Bearer ${ADMIN_KEY}` };

  async function createTenant(slug: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: adminAuth,
      payload: { name: `T-${slug}`, ownerEmail: `t-${slug}@example.com` },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { id: string }).id;
  }

  /** Add an Application (+ live key) to an existing Tenant. */
  async function addApplication(tenantId: string, slug: string): Promise<Workspace> {
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: adminAuth,
        payload: { tenantId, name: slug, slug },
      })
      .then((r) => r.json().data as { id: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: adminAuth,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    return { tenantId, applicationId: application.id, liveKey: key.rawKey };
  }

  async function bootstrap(slug: string): Promise<Workspace> {
    return addApplication(await createTenant(slug), slug);
  }

  async function setLimits(
    tenantId: string,
    limits: Record<string, unknown>,
  ): Promise<ReturnType<FastifyInstance['inject']>> {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: adminAuth,
      payload: limits,
    });
  }

  function signUp(ws: Workspace, email: string): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${ws.liveKey}` },
      payload: { email, password: PASSWORD },
    });
  }

  function signIn(ws: Workspace, email: string): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${ws.liveKey}` },
      payload: { email, password: PASSWORD },
    });
  }

  // ---------- unset = unlimited ----------

  it('creates end-users freely when the workspace has no limits set', async () => {
    const ws = await bootstrap('lim-none');

    // Sanity: the column really is null, not an empty object with a default.
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ws.tenantId } });
    expect(tenant.limits).toBeNull();

    for (let i = 0; i < 5; i++) {
      const res = await signUp(ws, `u${i}@example.com`);
      expect(res.statusCode).toBe(201);
    }
  });

  it('treats an explicitly null limit the same as no limit', async () => {
    const ws = await bootstrap('lim-null');
    expect((await setLimits(ws.tenantId, { maxActiveEndUsers: null })).statusCode).toBe(200);

    for (let i = 0; i < 3; i++) {
      expect((await signUp(ws, `n${i}@example.com`)).statusCode).toBe(201);
    }
  });

  // ---------- enforcement ----------

  it('blocks sign-up once the workspace is at its limit', async () => {
    const ws = await bootstrap('lim-block');
    await setLimits(ws.tenantId, { maxActiveEndUsers: 2 });

    expect((await signUp(ws, 'one@example.com')).statusCode).toBe(201);
    expect((await signUp(ws, 'two@example.com')).statusCode).toBe(201);

    const third = await signUp(ws, 'three@example.com');
    expect(third.statusCode).toBe(403);
    const error = third.json().error as { code: string; message: string; fix: string };
    expect(error.code).toBe('TENANT_QUOTA_EXCEEDED');
    expect(error.fix).toBeTruthy();
    // The message must name the ceiling and the count — an operator hitting
    // this needs to know how far over they are without another API call.
    expect(error.message).toContain('2');

    // And the refused user really was not created.
    expect(
      await prisma.endUser.count({ where: { application: { tenantId: ws.tenantId } } }),
    ).toBe(2);
  });

  it('a limit of 0 refuses the very first end-user', async () => {
    const ws = await bootstrap('lim-zero');
    await setLimits(ws.tenantId, { maxActiveEndUsers: 0 });

    const res = await signUp(ws, 'nobody@example.com');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_QUOTA_EXCEEDED');
  });

  it('lets existing end-users keep signing in when the workspace is over its limit', async () => {
    const ws = await bootstrap('lim-signin');
    expect((await signUp(ws, 'early@example.com')).statusCode).toBe(201);
    expect((await signUp(ws, 'later@example.com')).statusCode).toBe(201);

    // Retroactively drop the ceiling below current usage. Allowed on purpose.
    expect((await setLimits(ws.tenantId, { maxActiveEndUsers: 1 })).statusCode).toBe(200);

    // Both existing users still authenticate. This is the whole point: an
    // auth product must never lock people out of accounts they already have.
    for (const email of ['early@example.com', 'later@example.com']) {
      const res = await signIn(ws, email);
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { accessToken?: string }).accessToken).toBeTruthy();
    }

    // But no new one may join.
    expect((await signUp(ws, 'newcomer@example.com')).statusCode).toBe(403);
  });

  it('counts end-users across every application in the workspace, not per-application', async () => {
    const tenantId = await createTenant('lim-multi');
    const appA = await addApplication(tenantId, 'lim-multi-a');
    const appB = await addApplication(tenantId, 'lim-multi-b');
    await setLimits(tenantId, { maxActiveEndUsers: 2 });

    expect((await signUp(appA, 'a1@example.com')).statusCode).toBe(201);
    expect((await signUp(appB, 'b1@example.com')).statusCode).toBe(201);

    // Two users, in two different Applications, one workspace → full.
    // A per-application count would wrongly allow both of these.
    expect((await signUp(appA, 'a2@example.com')).statusCode).toBe(403);
    const blocked = await signUp(appB, 'b2@example.com');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('TENANT_QUOTA_EXCEEDED');
  });

  it('does not count another workspace\'s end-users', async () => {
    const mine = await bootstrap('lim-mine');
    const theirs = await bootstrap('lim-theirs');
    await setLimits(mine.tenantId, { maxActiveEndUsers: 1 });

    for (let i = 0; i < 3; i++) {
      expect((await signUp(theirs, `other${i}@example.com`)).statusCode).toBe(201);
    }
    expect((await signUp(mine, 'ours@example.com')).statusCode).toBe(201);
    expect((await signUp(mine, 'ours2@example.com')).statusCode).toBe(403);
  });

  it('does not count erased (tombstoned) end-users against the quota', async () => {
    const ws = await bootstrap('lim-erased');
    await setLimits(ws.tenantId, { maxActiveEndUsers: 1 });

    expect((await signUp(ws, 'gone@example.com')).statusCode).toBe(201);
    expect((await signUp(ws, 'blocked@example.com')).statusCode).toBe(403);

    // Tombstone the first — the row stays for FK integrity but the person is
    // gone, so the seat is freed.
    await prisma.endUser.updateMany({
      where: { applicationId: ws.applicationId },
      data: { erasedAt: new Date() },
    });

    expect((await signUp(ws, 'newseat@example.com')).statusCode).toBe(201);
  });

  it('gates the operator-driven manual create as well as SDK sign-up', async () => {
    // A quota the panel can walk around is not a quota. This path goes through
    // POST /api/v1/tenant/applications/:id/end-users with a tenant session.
    const suffix = Math.random().toString(36).slice(2, 8);
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-lim-${suffix}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${suffix}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const auth = { authorization: `Bearer ${token}` };

    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth,
        payload: { name: 'Manual', slug: `lim-manual-${suffix}` },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const tenantId = (
      await prisma.application.findUniqueOrThrow({ where: { id: appId }, select: { tenantId: true } })
    ).tenantId;
    await setLimits(tenantId, { maxActiveEndUsers: 1 });

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth,
      payload: { email: `m1-${suffix}@example.com`, password: 'pw-one-two-three' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth,
      payload: { email: `m2-${suffix}@example.com`, password: 'pw-one-two-three' },
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('TENANT_QUOTA_EXCEEDED');
  });

  // ---------- the admin surface ----------

  it('GET /limits reports the ceilings and current usage', async () => {
    const tenantId = await createTenant('lim-read');
    const appA = await addApplication(tenantId, 'lim-read-a');
    const appB = await addApplication(tenantId, 'lim-read-b');

    const unset = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: adminAuth,
    });
    expect(unset.statusCode).toBe(200);
    // Both helper applications default to DEVELOPMENT, so productionApps is 0.
    expect(unset.json().data).toEqual({
      limits: {},
      usage: { activeEndUsers: 0, productionApps: 0 },
    });

    await signUp(appA, 'r1@example.com');
    await signUp(appB, 'r2@example.com');
    await setLimits(tenantId, { maxActiveEndUsers: 10 });

    const set = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: adminAuth,
    });
    expect(set.json().data).toEqual({
      limits: { maxActiveEndUsers: 10 },
      usage: { activeEndUsers: 2, productionApps: 0 },
    });
  });

  it('PUT /limits replaces wholesale — an empty body clears every limit', async () => {
    const ws = await bootstrap('lim-clear');
    await setLimits(ws.tenantId, { maxActiveEndUsers: 1 });
    expect((await signUp(ws, 'c1@example.com')).statusCode).toBe(201);
    expect((await signUp(ws, 'c2@example.com')).statusCode).toBe(403);

    expect((await setLimits(ws.tenantId, {})).statusCode).toBe(200);
    expect((await signUp(ws, 'c2@example.com')).statusCode).toBe(201);
  });

  it('rejects an unknown limit key instead of silently ignoring it', async () => {
    const ws = await bootstrap('lim-typo');
    const res = await setLimits(ws.tenantId, { maxEndUsers: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TENANT_LIMITS');
  });

  it('rejects a negative limit', async () => {
    const ws = await bootstrap('lim-negative');
    const res = await setLimits(ws.tenantId, { maxActiveEndUsers: -1 });
    expect(res.statusCode).toBe(400);
  });

  it('404s on an unknown tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenants/does-not-exist/limits',
      headers: adminAuth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TENANT_NOT_FOUND');
  });

  // ---------- only a super-admin may move the number ----------

  it('refuses to set limits without the super-admin key', async () => {
    const ws = await bootstrap('lim-noauth');

    const anonymous = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/tenants/${ws.tenantId}/limits`,
      payload: { maxActiveEndUsers: 999 },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('ADMIN_AUTH_MISSING');

    const wrongKey = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/tenants/${ws.tenantId}/limits`,
      headers: { authorization: 'Bearer not-the-admin-key' },
      payload: { maxActiveEndUsers: 999 },
    });
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.json().error.code).toBe('ADMIN_AUTH_INVALID');

    // GET is gated identically — the limits surface is super-admin-only end to end.
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${ws.tenantId}/limits`,
    });
    expect(read.statusCode).toBe(401);
  });

  it('does not let a workspace operator raise their own quota', async () => {
    // The operator's own credential is a tenant session, not the deployment
    // key. Presenting it to the admin surface must fail exactly like any other
    // wrong bearer — otherwise the quota is self-service.
    const suffix = Math.random().toString(36).slice(2, 8);
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-raise-${suffix}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${suffix}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const tenantId = (
      await prisma.tenant.findFirstOrThrow({ where: { name: `WS ${suffix}` }, select: { id: true } })
    ).id;
    await setLimits(tenantId, { maxActiveEndUsers: 1 });

    const attempt = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: { authorization: `Bearer ${token}` },
      payload: { maxActiveEndUsers: 1_000_000 },
    });
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json().error.code).toBe('ADMIN_AUTH_INVALID');

    // Unchanged.
    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: adminAuth,
    });
    expect((after.json().data as { limits: { maxActiveEndUsers: number } }).limits).toEqual({
      maxActiveEndUsers: 1,
    });
  });
});
