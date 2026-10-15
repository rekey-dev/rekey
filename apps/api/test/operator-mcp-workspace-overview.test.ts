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
import { pricedAt } from './subscription-price-fixture.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { seedPlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

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
    const monthly = await seedPlan({ applicationId: w.appId, slug: 'm', name: 'M', interval: 'MONTH' }, { currency: 'usd', amount: 100 });
    const yearly = await seedPlan({ applicationId: w.appId, slug: 'y', name: 'Y', interval: 'YEAR' }, { currency: 'usd', amount: 1200 });
    const usage = await seedPlan({ applicationId: w.appId, slug: 'u', name: 'U', interval: 'MONTH', kind: 'USAGE' }, { currency: 'usd', amount: 5000 });
    const n = 10_005;
    const monthlyPrice = await pricedAt(monthly.id, 'USD', 100);
    await prisma.$executeRaw`
      INSERT INTO "end_users" ("id", "application_id", "email", "created_at", "updated_at")
      SELECT 'mrr_' || g, ${w.appId}, 'mrr' || g || '@example.com', now(), now() FROM generate_series(1, ${n}) g`;
    await prisma.$executeRaw`
      INSERT INTO "subscriptions" ("id", "application_id", "end_user_id", "plan_id", "status", "currency", "unit_amount", "plan_price_id", "created_at", "updated_at")
      SELECT 'sub_' || g, ${w.appId}, 'mrr_' || g, ${monthly.id}, 'ACTIVE', 'USD', 100, ${monthlyPrice.planPriceId}, now(), now() FROM generate_series(1, ${n}) g`;
    await prisma.subscription.create({
      data: { applicationId: w.appId, endUserId: 'mrr_1', planId: yearly.id, status: 'ACTIVE', ...(await pricedAt(yearly.id, 'USD', 1200)) },
    });
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: 'mrr_2', planId: usage.id, status: 'ACTIVE' } });
    // ACTIVE on a plan that costs 900 a month, with no price of its own: in no currency's MRR.
    const unpricedPlan = await seedPlan({ applicationId: w.appId, slug: 'n', name: 'N', interval: 'MONTH' }, { currency: 'usd', amount: 900 });
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: 'mrr_4', planId: unpricedPlan.id, status: 'ACTIVE' } });

    const overview = (await tool('get_workspace_overview').handler(await ctxFor(w, 'OWNER'), {})) as {
      activeSubscriptions: number;
      currencies: Array<{ currency: string; mrrMinor: number; activeSubscriptions: number }>;
    };
    const expected = n * 100 + 100;
    expect(overview.currencies).toEqual([{ currency: 'USD', mrrMinor: expected, activeSubscriptions: n + 1 }]);
    expect(overview).not.toHaveProperty('mrrMinor');
    expect(overview).not.toHaveProperty('mrrCurrency');

    expect(overview.activeSubscriptions).toBe(n + 3);
    const billing = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/billing/stats`, headers: bearer(w.ownerToken) });
    expect(billing.json().data.mrr).toEqual([{ currency: 'USD', mrrCents: expected, activeSubscriptions: n + 1 }]);

    // A second currency is listed beside the first and never added to it.
    const eur = await seedPlan({ applicationId: w.appId, slug: 'e', name: 'E', interval: 'MONTH' }, { currency: 'EUR', amount: 700 });
    await prisma.subscription.create({
      data: { applicationId: w.appId, endUserId: 'mrr_3', planId: eur.id, status: 'ACTIVE', ...(await pricedAt(eur.id, 'EUR', 700)) },
    });
    const mixed = (await tool('get_workspace_overview').handler(await ctxFor(w, 'OWNER'), {})) as typeof overview;
    expect(mixed.currencies).toEqual([
      { currency: 'USD', mrrMinor: expected, activeSubscriptions: n + 1 },
      { currency: 'EUR', mrrMinor: 700, activeSubscriptions: 1 },
    ]);
  }, 60_000);

  it('amounts need billing:read, whatever the grant preset says', async () => {
    const w = await operatorWorld(app, 'APP_VIEWER');
    const withBilling = (await tool('get_workspace_overview').handler(await ctxFor(w, 'MEMBER'), {})) as Record<string, unknown>;
    expect(withBilling).toHaveProperty('currencies');
    const without = (await tool('get_workspace_overview').handler(
      await ctxFor(w, 'MEMBER', new Set<Scope>(['overview:read'])),
      {},
    )) as Record<string, unknown>;
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
