/**
 * The workspace overview and application list on the operator MCP: MRR is
 * the Billing Overview's figure with no cap, amounts need billing:read, and
 * the list costs a fixed number of statements however many Applications.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { UNRESTRICTED, type Scope } from '../src/lib/operator-scopes.js';
import { allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { rollupApplication } from '../src/modules/analytics/rollup/job.js';
import { countQueries } from './query-counter.js';
import { seedUsers } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

const tool = (name: string) => allOperatorTools.find((t) => t.name === name)!;

describe('operator MCP workspace overview', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function ctxFor(w: OperatorWorld, role: 'OWNER' | 'MEMBER', scopes: ReadonlySet<Scope> = UNRESTRICTED): Promise<OperatorToolContext> {
    const a = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    const m = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: a.tenantId, role } });
    return { tenantUserId: m.tenantUserId, tenantId: a.tenantId, role, tenantMembershipId: m.id, scopes, canWrite: false, canAdmin: false };
  }

  it('MRR counts every ACTIVE subscription past 10,000, excludes non-recurring plans, and equals Billing Overview', async () => {
    const w = await operatorWorld(app);
    const monthly = await prisma.plan.create({ data: { applicationId: w.appId, slug: 'm', name: 'M', amount: 100, currency: 'usd', interval: 'MONTH' } });
    const yearly = await prisma.plan.create({ data: { applicationId: w.appId, slug: 'y', name: 'Y', amount: 1200, currency: 'usd', interval: 'YEAR' } });
    const usage = await prisma.plan.create({ data: { applicationId: w.appId, slug: 'u', name: 'U', amount: 5000, currency: 'usd', interval: 'MONTH', kind: 'USAGE' } });
    const n = 10_005;
    await prisma.$executeRaw`
      INSERT INTO "end_users" ("id", "application_id", "email", "created_at", "updated_at")
      SELECT 'mrr_' || g, ${w.appId}, 'mrr' || g || '@example.com', now(), now() FROM generate_series(1, ${n}) g`;
    await prisma.$executeRaw`
      INSERT INTO "subscriptions" ("id", "application_id", "end_user_id", "plan_id", "status", "created_at", "updated_at")
      SELECT 'sub_' || g, ${w.appId}, 'mrr_' || g, ${monthly.id}, 'ACTIVE', now(), now() FROM generate_series(1, ${n}) g`;
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: 'mrr_1', planId: yearly.id, status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: 'mrr_2', planId: usage.id, status: 'ACTIVE' } });

    const overview = (await tool('get_workspace_overview').handler(await ctxFor(w, 'OWNER'), {})) as {
      mrrMinor: number;
      activeSubscriptions: number;
      currencies: Array<{ currency: string; mrrMinor: number }>;
    };
    const expected = n * 100 + 100;
    expect(overview.mrrMinor).toBe(expected);
    expect(overview.currencies).toEqual([{ currency: 'USD', mrrMinor: expected }]);
    expect(overview.activeSubscriptions).toBe(n + 2);
    const billing = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/billing/stats`, headers: bearer(w.ownerToken) });
    expect(billing.json().data).toMatchObject({ mrrCents: expected, mrrCurrency: 'USD', mixedCurrencies: false });
  }, 60_000);

  it('amounts need billing:read, whatever the grant preset says', async () => {
    const w = await operatorWorld(app, 'APP_VIEWER');
    const withBilling = (await tool('get_workspace_overview').handler(await ctxFor(w, 'MEMBER'), {})) as Record<string, unknown>;
    expect(withBilling).toHaveProperty('mrrMinor');
    const without = (await tool('get_workspace_overview').handler(
      await ctxFor(w, 'MEMBER', new Set<Scope>(['overview:read'])),
      {},
    )) as Record<string, unknown>;
    expect(without).not.toHaveProperty('mrrMinor');
    expect(without).not.toHaveProperty('currencies');
    expect(without).toHaveProperty('activeSubscriptions');
  });

  it('list_applications reads the snapshot and DAU, in the same number of statements for 2 or 12 apps', async () => {
    const w = await operatorWorld(app);
    await seedUsers(w.appId, 25, 4, 10);
    await rollupApplication(w.appId);
    const ctx = await ctxFor(w, 'OWNER');
    const listed = (await tool('list_applications').handler(ctx, {})) as {
      applications: Array<{ id: string; endUserCount: number; endUserCountAsOf: string; dau?: number; activityTimezone?: string }>;
    };
    const row = listed.applications.find((a) => a.id === w.appId)!;
    expect(row.endUserCount).toBe(25);
    expect(row.activityTimezone).toBe('UTC');
    expect(typeof row.dau).toBe('number');

    const newApp = (i: number) =>
      w.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: bearer(w.ownerToken),
        payload: { name: `x${i}`, slug: `x${i}-${Math.random().toString(36).slice(2, 7)}` },
      });
    await newApp(99);
    const a = await countQueries(() => tool('list_applications').handler(ctx, {}));
    for (let i = 0; i < 10; i++) {
      await w.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: bearer(w.ownerToken),
        payload: { name: `x${i}`, slug: `x${i}-${Math.random().toString(36).slice(2, 7)}` },
      });
    }
    const b = await countQueries(() => tool('list_applications').handler(ctx, {}));
    expect(b.count).toBe(a.count);
    expect(a.count).toBeLessThanOrEqual(8);
  });
});
