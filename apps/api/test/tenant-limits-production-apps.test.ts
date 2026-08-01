/**
 * Per-workspace ceiling on PRODUCTION Applications — the enforcement primitive
 * behind per-production-app pricing.
 *
 * The assertions that make this safe to ship:
 *   1. Unset = unlimited. Every workspace that existed before this key did must
 *      be unaffected by it existing.
 *   2. Only PRODUCTION counts. A workspace at its ceiling can still create
 *      development and staging Applications — that is the whole "test
 *      environments are free" promise, and if it regresses we start charging
 *      people for scratch apps.
 *   3. Being over the line never takes an existing production app offline. The
 *      quota gates creation, exactly like maxActiveEndUsers.
 *
 * `Application.environment` is write-once, which is what makes counting at
 * creation sufficient — there is no promote-a-dev-app path to police.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('Tenant limits — maxProductionApps', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

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

  function createApp(
    tenantId: string,
    slug: string,
    environment?: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT',
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: adminAuth,
      payload: {
        tenantId,
        name: slug,
        slug,
        ...(environment !== undefined && { environment }),
      },
    });
  }

  function setLimits(
    tenantId: string,
    limits: Record<string, unknown>,
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: adminAuth,
      payload: limits,
    });
  }

  // ---------- unset = unlimited ----------

  it('creates production apps freely when no limit is set', async () => {
    const tenantId = await createTenant('mpa-none');

    // Sanity: the column is genuinely null, not an object with a default.
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.limits).toBeNull();

    for (const n of [1, 2, 3]) {
      expect((await createApp(tenantId, `mpa-none-${n}`, 'PRODUCTION')).statusCode).toBe(201);
    }
  });

  it('treats an explicit null as unlimited', async () => {
    const tenantId = await createTenant('mpa-null');
    expect((await setLimits(tenantId, { maxProductionApps: null })).statusCode).toBe(200);

    expect((await createApp(tenantId, 'mpa-null-1', 'PRODUCTION')).statusCode).toBe(201);
    expect((await createApp(tenantId, 'mpa-null-2', 'PRODUCTION')).statusCode).toBe(201);
  });

  // ---------- the ceiling ----------

  it('blocks the production app that would cross the line, with TENANT_QUOTA_EXCEEDED', async () => {
    const tenantId = await createTenant('mpa-cap');
    await setLimits(tenantId, { maxProductionApps: 2 });

    expect((await createApp(tenantId, 'mpa-cap-1', 'PRODUCTION')).statusCode).toBe(201);
    expect((await createApp(tenantId, 'mpa-cap-2', 'PRODUCTION')).statusCode).toBe(201);

    const third = await createApp(tenantId, 'mpa-cap-3', 'PRODUCTION');
    expect(third.statusCode).toBe(403);
    expect(third.json().error.code).toBe('TENANT_QUOTA_EXCEEDED');
  });

  it('a limit of 0 forbids production apps entirely', async () => {
    const tenantId = await createTenant('mpa-zero');
    await setLimits(tenantId, { maxProductionApps: 0 });

    const res = await createApp(tenantId, 'mpa-zero-1', 'PRODUCTION');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_QUOTA_EXCEEDED');
  });

  // ---------- non-production is free ----------

  it('still allows development and staging apps at the ceiling', async () => {
    const tenantId = await createTenant('mpa-free');
    await setLimits(tenantId, { maxProductionApps: 1 });

    expect((await createApp(tenantId, 'mpa-free-prod', 'PRODUCTION')).statusCode).toBe(201);
    // At the ceiling now — but only PRODUCTION is supposed to count.
    expect((await createApp(tenantId, 'mpa-free-dev', 'DEVELOPMENT')).statusCode).toBe(201);
    expect((await createApp(tenantId, 'mpa-free-stg', 'STAGING')).statusCode).toBe(201);
    // And an omitted environment defaults to DEVELOPMENT, so it is not billable
    // and must not be blocked either.
    expect((await createApp(tenantId, 'mpa-free-default')).statusCode).toBe(201);
  });

  it('does not count development or staging apps toward the ceiling', async () => {
    const tenantId = await createTenant('mpa-count');
    await setLimits(tenantId, { maxProductionApps: 1 });

    for (const n of [1, 2, 3]) {
      expect((await createApp(tenantId, `mpa-count-dev-${n}`, 'DEVELOPMENT')).statusCode).toBe(201);
    }
    // Three non-production apps exist; the single production slot is untouched.
    expect((await createApp(tenantId, 'mpa-count-prod', 'PRODUCTION')).statusCode).toBe(201);
  });

  // ---------- over the line never breaks what exists ----------

  it('lowering the limit below current usage leaves existing production apps alive', async () => {
    const tenantId = await createTenant('mpa-lower');
    expect((await createApp(tenantId, 'mpa-lower-1', 'PRODUCTION')).statusCode).toBe(201);
    expect((await createApp(tenantId, 'mpa-lower-2', 'PRODUCTION')).statusCode).toBe(201);

    // Allowed: a workspace has to be able to be moved to a smaller plan.
    expect((await setLimits(tenantId, { maxProductionApps: 1 })).statusCode).toBe(200);

    const apps = await prisma.application.findMany({
      where: { tenantId, environment: 'PRODUCTION' },
      select: { id: true },
    });
    expect(apps).toHaveLength(2);

    // New ones are refused until they come back under the line.
    expect((await createApp(tenantId, 'mpa-lower-3', 'PRODUCTION')).statusCode).toBe(403);
  });

  // ---------- read surface ----------

  it('reports productionApps usage alongside the limits', async () => {
    const tenantId = await createTenant('mpa-usage');
    await setLimits(tenantId, { maxProductionApps: 5 });
    await createApp(tenantId, 'mpa-usage-p1', 'PRODUCTION');
    await createApp(tenantId, 'mpa-usage-p2', 'PRODUCTION');
    await createApp(tenantId, 'mpa-usage-d1', 'DEVELOPMENT');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: adminAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      limits: { maxProductionApps?: number | null };
      usage: { productionApps: number };
    };
    expect(body.limits.maxProductionApps).toBe(5);
    expect(body.usage.productionApps).toBe(2); // the DEVELOPMENT app is not counted
  });

  // ---------- the limits are workspace-scoped ----------

  it('counts per workspace, not deployment-wide', async () => {
    const a = await createTenant('mpa-iso-a');
    const b = await createTenant('mpa-iso-b');
    await setLimits(a, { maxProductionApps: 1 });
    await setLimits(b, { maxProductionApps: 1 });

    expect((await createApp(a, 'mpa-iso-a-1', 'PRODUCTION')).statusCode).toBe(201);
    // b is untouched by a being full.
    expect((await createApp(b, 'mpa-iso-b-1', 'PRODUCTION')).statusCode).toBe(201);
    expect((await createApp(a, 'mpa-iso-a-2', 'PRODUCTION')).statusCode).toBe(403);
  });

  // ---------- only a super-admin can move it ----------

  it('rejects a non-integer limit', async () => {
    const tenantId = await createTenant('mpa-bad');
    // Rejected by the route's JSON schema (BAD_REQUEST), before the zod parse
    // that produces INVALID_TENANT_LIMITS — the type is declared there.
    expect((await setLimits(tenantId, { maxProductionApps: 'lots' })).statusCode).toBe(400);
  });

  it('rejects a misspelled key instead of silently ignoring it', async () => {
    const tenantId = await createTenant('mpa-typo');
    // Not declared in the JSON schema, so fastify lets it through and the
    // strict zod parse is what catches it. A typo'd limit key must never look
    // like it applied.
    const res = await setLimits(tenantId, { maxProductionApp: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TENANT_LIMITS');
  });

  it('rejects a negative limit', async () => {
    const tenantId = await createTenant('mpa-neg');
    expect((await setLimits(tenantId, { maxProductionApps: -1 })).statusCode).toBe(400);
  });

  it('PUT replaces wholesale — an omitted key becomes unlimited', async () => {
    const tenantId = await createTenant('mpa-put');
    await setLimits(tenantId, { maxActiveEndUsers: 10, maxProductionApps: 1 });

    // Omitting maxProductionApps clears it, per documented PUT semantics.
    const res = await setLimits(tenantId, { maxActiveEndUsers: 10 });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { limits: Record<string, unknown> }).limits.maxProductionApps)
      .toBeUndefined();

    expect((await createApp(tenantId, 'mpa-put-1', 'PRODUCTION')).statusCode).toBe(201);
    expect((await createApp(tenantId, 'mpa-put-2', 'PRODUCTION')).statusCode).toBe(201);
  });
});
