/**
 * DEFAULT_TENANT_LIMITS — the ceilings a deployment stamps on every workspace
 * it creates.
 *
 * `Tenant.limits` is otherwise only ever written after the fact by the
 * super-admin endpoint, so a workspace nobody runs that endpoint against is
 * unbounded — which is every workspace a self-serve sign-up produces. This
 * covers the closing of that gap, and the three properties that make it safe:
 *
 *   1. **Unset = unlimited.** A deployment that never sets the variable behaves
 *      exactly as it does today. That is the self-host guarantee and it is the
 *      first test here for a reason.
 *   2. **All four `tenant.create` sites apply it.** Password sign-up, OAuth
 *      first-login, workspace-create and the super-admin path. A default
 *      applied on three of four is not a default; it is a workaround waiting to
 *      be found.
 *   3. **An explicit value wins.** The super-admin path is how a bespoke
 *      workspace gets provisioned, so limits passed there beat the default —
 *      including an explicit `{}`, meaning "unlimited, deliberately".
 *
 * The variable is read live from process.env by lib/tenant-limits.ts, so each
 * test sets it directly and clears it afterwards (the suite runs single-fork).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { assertDefaultTenantLimitsValid } from '../src/lib/tenant-limits.js';
import { tenantAuthService } from '../src/modules/tenant-auth/tenant-auth.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('DEFAULT_TENANT_LIMITS', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    // Restore "unset" so other test files (which assume unlimited) are unaffected.
    delete process.env.DEFAULT_TENANT_LIMITS;
  });

  const adminAuth = { authorization: `Bearer ${ADMIN_KEY}` };

  async function signUp(
    email: string,
    workspaceName: string,
  ): Promise<{ activeTenantId: string; accessToken: string }> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data as { activeTenantId: string; accessToken: string };
  }

  async function storedLimits(tenantId: string): Promise<unknown> {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { limits: true } });
    return t?.limits ?? null;
  }

  function createProductionApp(
    tenantId: string,
    slug: string,
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: adminAuth,
      payload: { tenantId, name: slug, slug, environment: 'PRODUCTION' },
    });
  }

  // ---------- the self-host guarantee ----------

  it('unset → a workspace from operator sign-up is unlimited', async () => {
    const { activeTenantId } = await signUp('unset@example.com', 'Unset Co');
    expect(await storedLimits(activeTenantId)).toBeNull();

    // And the quota is genuinely not enforced: two production apps, no 403.
    expect((await createProductionApp(activeTenantId, 'unset-a')).statusCode).toBe(201);
    expect((await createProductionApp(activeTenantId, 'unset-b')).statusCode).toBe(201);
  });

  it('unset → a workspace from the super-admin path is unlimited', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: adminAuth,
      payload: { name: 'Admin Unset', ownerEmail: 'admin-unset@example.com' },
    });
    expect(r.statusCode).toBe(201);
    expect(await storedLimits((r.json().data as { id: string }).id)).toBeNull();
  });

  // ---------- all four creation sites ----------

  it('set → an operator sign-up workspace carries it, and the quota then blocks', async () => {
    process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":1}';
    const { activeTenantId } = await signUp('signup@example.com', 'Signup Co');
    expect(await storedLimits(activeTenantId)).toEqual({ maxProductionApps: 1 });

    expect((await createProductionApp(activeTenantId, 'sig-a')).statusCode).toBe(201);
    const second = await createProductionApp(activeTenantId, 'sig-b');
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('TENANT_QUOTA_EXCEEDED');

    // Non-production environments are still free — the ceiling counts PRODUCTION only.
    const dev = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: adminAuth,
      payload: {
        tenantId: activeTenantId,
        name: 'sig-dev',
        slug: 'sig-dev',
        environment: 'DEVELOPMENT',
      },
    });
    expect(dev.statusCode).toBe(201);
  });

  it('set → a workspace created via POST /tenant/workspace carries it too', async () => {
    process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":1}';
    const { accessToken } = await signUp('second-ws@example.com', 'First Co');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Second Co' },
    });
    expect(created.statusCode).toBe(200);
    const second = (created.json().data as { id: string }).id;
    expect(await storedLimits(second)).toEqual({ maxProductionApps: 1 });
  });

  it('set → an OAuth first-login workspace carries it', async () => {
    process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":2}';
    const user = await tenantAuthService.findOrCreateOAuthOperator({
      email: 'oauth-default@example.com',
      emailVerified: true,
    });
    const membership = await prisma.tenantMembership.findFirst({
      where: { tenantUserId: user.id },
    });
    expect(membership).not.toBeNull();
    expect(await storedLimits(membership!.tenantId)).toEqual({ maxProductionApps: 2 });
  });

  it('set → the super-admin path takes the default when no limits are passed', async () => {
    process.env.DEFAULT_TENANT_LIMITS = '{"maxActiveEndUsers":50,"maxProductionApps":1}';
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: adminAuth,
      payload: { name: 'Admin Default', ownerEmail: 'admin-default@example.com' },
    });
    expect(r.statusCode).toBe(201);
    expect(await storedLimits((r.json().data as { id: string }).id)).toEqual({
      maxActiveEndUsers: 50,
      maxProductionApps: 1,
    });
  });

  // ---------- explicit wins ----------

  it('explicit limits on the super-admin path beat the default', async () => {
    process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":1}';
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: adminAuth,
      payload: {
        name: 'Bespoke Co',
        ownerEmail: 'bespoke@example.com',
        limits: { maxProductionApps: 5 },
      },
    });
    expect(r.statusCode).toBe(201);
    const tenantId = (r.json().data as { id: string }).id;
    expect(await storedLimits(tenantId)).toEqual({ maxProductionApps: 5 });

    // The higher explicit ceiling is the one actually enforced.
    for (const slug of ['b1', 'b2']) {
      expect((await createProductionApp(tenantId, slug)).statusCode).toBe(201);
    }
  });

  it('an explicit empty limits object means unlimited, overriding the default', async () => {
    process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":1}';
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: adminAuth,
      payload: { name: 'Uncapped Co', ownerEmail: 'uncapped@example.com', limits: {} },
    });
    expect(r.statusCode).toBe(201);
    const tenantId = (r.json().data as { id: string }).id;
    expect(await storedLimits(tenantId)).toEqual({});
    expect((await createProductionApp(tenantId, 'u1')).statusCode).toBe(201);
    expect((await createProductionApp(tenantId, 'u2')).statusCode).toBe(201);
  });

  it('a typo in explicit limits is a 400, not a silently uncapped workspace', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: adminAuth,
      payload: {
        name: 'Typo Co',
        ownerEmail: 'typo@example.com',
        limits: { maxProductionApp: 1 },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_TENANT_LIMITS');
    expect(await prisma.tenant.count({ where: { name: 'Typo Co' } })).toBe(0);
  });

  // ---------- boot validation ----------

  describe('boot validation', () => {
    it('accepts unset, empty, and well-formed values', () => {
      delete process.env.DEFAULT_TENANT_LIMITS;
      expect(() => assertDefaultTenantLimitsValid()).not.toThrow();

      process.env.DEFAULT_TENANT_LIMITS = '';
      expect(() => assertDefaultTenantLimitsValid()).not.toThrow();

      process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":1,"maxActiveEndUsers":1000}';
      expect(() => assertDefaultTenantLimitsValid()).not.toThrow();

      process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":null}';
      expect(() => assertDefaultTenantLimitsValid()).not.toThrow();
    });

    it('rejects malformed JSON', () => {
      process.env.DEFAULT_TENANT_LIMITS = '{maxProductionApps: 1}';
      expect(() => assertDefaultTenantLimitsValid()).toThrow(/DEFAULT_TENANT_LIMITS/);
    });

    it('rejects a value that is not a JSON object', () => {
      for (const raw of ['1', '"1"', '[{"maxProductionApps":1}]']) {
        process.env.DEFAULT_TENANT_LIMITS = raw;
        expect(() => assertDefaultTenantLimitsValid()).toThrow(/not a JSON object/);
      }
    });

    it('rejects an unknown key — a typo must not read as "no ceiling"', () => {
      process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApp":1}';
      expect(() => assertDefaultTenantLimitsValid()).toThrow(/DEFAULT_TENANT_LIMITS/);
    });

    it('rejects an out-of-range value', () => {
      process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":-1}';
      expect(() => assertDefaultTenantLimitsValid()).toThrow(/DEFAULT_TENANT_LIMITS/);
    });

    it('buildApp refuses to start on a malformed value', async () => {
      process.env.DEFAULT_TENANT_LIMITS = 'not-json-at-all';
      await expect(buildApp({ logger: false })).rejects.toThrow(/DEFAULT_TENANT_LIMITS/);
    });
  });

  // ---------- runtime safety ----------

  it('a workspace created while the default is malformed is unlimited, not half-capped', async () => {
    // Boot validation makes this unreachable in a real deployment; the point is
    // that the runtime read never invents a ceiling from an unparseable value.
    process.env.DEFAULT_TENANT_LIMITS = '{"maxProductionApps":';
    const { activeTenantId } = await signUp('broken@example.com', 'Broken Co');
    expect(await storedLimits(activeTenantId)).toBeNull();
  });
});
