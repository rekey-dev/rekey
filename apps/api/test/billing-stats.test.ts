/**
 * Tenant billing stats endpoint — GET /tenant/applications/:id/billing/stats.
 *
 * Seeds subscriptions + payments directly (deterministic dates) and asserts:
 *   - subscription counters (active / past-due / canceled+new in 30d),
 *   - MRR math: MONTH at face value, YEAR floored to /12, USAGE + CREDIT
 *     (non-recurring) plans excluded,
 *   - 30-day payment volume + succeeded/failed counts,
 *   - the 12-month UTC monthly-revenue series (gap-filled, window-clipped),
 *   - workspace scoping (404 from another tenant).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface BillingStats {
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  canceledLast30d: number;
  newSubscriptionsLast30d: number;
  mrrCents: number;
  mrrCurrency: string | null;
  mixedCurrencies: boolean;
  revenueLast30dCents: number;
  paymentsLast30d: { succeeded: number; failed: number };
  monthlyRevenue: Array<{ month: string; amountCents: number }>;
}

/** `YYYY-MM` key + a timestamp safely INSIDE the month `monthsBack` ago (UTC). */
function monthRef(monthsBack: number): { key: string; at: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  return {
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    at: new Date(start.getTime() + 2 * 60 * 60 * 1000), // 02:00 on the 1st
  };
}

describe('GET /tenant/applications/:id/billing/stats', () => {
  let app: FastifyInstance;
  let tenantAccess: string;
  let applicationId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  // The shared test setup truncates all domain tables before EACH test, so
  // bootstrap + seed must run per test (same pattern as stripe-webhook.test.ts).
  beforeEach(async () => {
    tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'op-billing-stats@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'WS billing-stats',
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'BillingStats', slug: 'billing-stats-app', enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    await seed();
  });

  afterAll(async () => {
    await app.close();
  });

  async function seed(): Promise<void> {
    // ---- plans -------------------------------------------------------
    const [monthly, yearly, creditPack, usagePlan] = await Promise.all([
      prisma.plan.create({
        data: { applicationId, slug: 'pro_m', name: 'Pro M', amount: 1000, interval: 'MONTH', kind: 'SUBSCRIPTION' },
      }),
      prisma.plan.create({
        // 10000/12 = 833.33… → per-sub monthly contribution floors to 833.
        data: { applicationId, slug: 'pro_y', name: 'Pro Y', amount: 10000, interval: 'YEAR', kind: 'SUBSCRIPTION' },
      }),
      prisma.plan.create({
        data: { applicationId, slug: 'credits', name: 'Credits', amount: 5000, kind: 'CREDIT', creditsAmount: 100 },
      }),
      prisma.plan.create({
        data: { applicationId, slug: 'metered', name: 'Metered', amount: 9999, kind: 'USAGE', meterSlug: 'api', pricePerUnitCents: 1 },
      }),
    ]);

    // One end-user per subscription — (applicationId, endUserId, planId) is unique.
    const eu = async (n: number): Promise<string> =>
      (await prisma.endUser.create({ data: { applicationId, email: `bs-${n}@example.com` } })).id;

    // ---- subscriptions ------------------------------------------------
    // ACTIVE: 2× monthly (1000 each) + 1× yearly (833) + credit + usage
    // (excluded from MRR) → MRR = 2833, activeSubscriptions = 5.
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(1), planId: monthly.id, status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(2), planId: monthly.id, status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(3), planId: yearly.id, status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(4), planId: creditPack.id, status: 'ACTIVE' } });
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(5), planId: usagePlan.id, status: 'ACTIVE' } });
    // 1× PAST_DUE.
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(6), planId: monthly.id, status: 'PAST_DUE' } });
    // Canceled 5 days ago → inside the 30d window.
    await prisma.subscription.create({
      data: {
        applicationId, endUserId: await eu(7), planId: monthly.id, status: 'CANCELED',
        canceledAt: new Date(Date.now() - 5 * DAY_MS),
      },
    });
    // Canceled 60 days ago (created 90 days ago) → outside BOTH 30d windows.
    await prisma.subscription.create({
      data: {
        applicationId, endUserId: await eu(8), planId: monthly.id, status: 'CANCELED',
        canceledAt: new Date(Date.now() - 60 * DAY_MS),
        createdAt: new Date(Date.now() - 90 * DAY_MS),
      },
    });

    // ---- payments -----------------------------------------------------
    // Recent (always inside the 30d window): 1500 + 2500 SUCCEEDED, one FAILED.
    await prisma.payment.create({
      data: { applicationId, amount: 1500, currency: 'USD', status: 'SUCCEEDED', createdAt: new Date(Date.now() - 1 * DAY_MS) },
    });
    await prisma.payment.create({
      data: { applicationId, amount: 2500, currency: 'USD', status: 'SUCCEEDED', createdAt: new Date(Date.now() - 2 * DAY_MS) },
    });
    await prisma.payment.create({
      data: { applicationId, amount: 999, currency: 'USD', status: 'FAILED', createdAt: new Date(Date.now() - 3 * DAY_MS) },
    });
    // Two months back: lands in exactly one known bucket of the series.
    await prisma.payment.create({
      data: { applicationId, amount: 7000, currency: 'USD', status: 'SUCCEEDED', createdAt: monthRef(2).at },
    });
    // 13 months back: OUTSIDE the 12-month series entirely.
    await prisma.payment.create({
      data: { applicationId, amount: 11111, currency: 'USD', status: 'SUCCEEDED', createdAt: monthRef(13).at },
    });
    // FAILED inside the series window must not pollute monthlyRevenue.
    await prisma.payment.create({
      data: { applicationId, amount: 4242, currency: 'USD', status: 'FAILED', createdAt: monthRef(2).at },
    });
  }

  it('returns the subscription counters and MRR (YEAR normalized, USAGE/CREDIT excluded)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json().data as BillingStats;

    expect(stats.activeSubscriptions).toBe(5);
    expect(stats.pastDueSubscriptions).toBe(1);
    expect(stats.canceledLast30d).toBe(1);
    // Everything seeded "now" except the backdated old-canceled row: 5 active
    // + 1 past-due + 1 recent-canceled = 7.
    expect(stats.newSubscriptionsLast30d).toBe(7);
    // 2×1000 (MONTH) + floor(10000/12)=833 (YEAR) — CREDIT + USAGE excluded.
    expect(stats.mrrCents).toBe(2833);
    expect(stats.mrrCurrency).toBe('USD');
    expect(stats.mixedCurrencies).toBe(false);
  });

  it('never sums MRR across currencies — reports the dominant one and flags mixing', async () => {
    // Add an EUR plan with one active sub (500/mo). USD MRR (2833) dominates.
    const eurPlan = await prisma.plan.create({
      data: { applicationId, slug: 'pro_eur', name: 'Pro EUR', amount: 500, currency: 'EUR', interval: 'MONTH', kind: 'SUBSCRIPTION' },
    });
    const euUser = await prisma.endUser.create({ data: { applicationId, email: 'bs-eur@example.com' } });
    await prisma.subscription.create({
      data: { applicationId, endUserId: euUser.id, planId: eurPlan.id, status: 'ACTIVE' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    const stats = res.json().data as BillingStats;

    // Dominant currency only — NOT 2833 + 500.
    expect(stats.mrrCents).toBe(2833);
    expect(stats.mrrCurrency).toBe('USD');
    expect(stats.mixedCurrencies).toBe(true);
  });

  it('aggregates 30-day payment volume and succeeded/failed counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    const stats = res.json().data as BillingStats;

    expect(stats.revenueLast30dCents).toBe(4000); // 1500 + 2500
    expect(stats.paymentsLast30d.succeeded).toBe(2);
    expect(stats.paymentsLast30d.failed).toBe(1);
  });

  it('buckets SUCCEEDED revenue into 12 gap-filled UTC months', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    const stats = res.json().data as BillingStats;

    expect(stats.monthlyRevenue).toHaveLength(12);
    // Oldest-first, current month last.
    expect(stats.monthlyRevenue[11]!.month).toBe(monthRef(0).key);
    expect(stats.monthlyRevenue[0]!.month).toBe(monthRef(11).key);

    // The 7000 payment lands in its month's bucket — alone (the FAILED 4242 in
    // the same month is excluded, the recent ones can't be 2 months back).
    const twoBack = stats.monthlyRevenue.find((m) => m.month === monthRef(2).key);
    expect(twoBack?.amountCents).toBe(7000);

    // Series total = recent SUCCEEDED (4000) + 7000; the 13-months-back 11111
    // is clipped by the window, FAILED rows never count.
    const total = stats.monthlyRevenue.reduce((s, m) => s + m.amountCents, 0);
    expect(total).toBe(11000);

    // Gap-filling: every month key present exactly once, in order.
    const keys = stats.monthlyRevenue.map((m) => m.month);
    expect(new Set(keys).size).toBe(12);
  });

  it('is scoped to the active workspace (404 from another tenant)', async () => {
    const otherAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'op-billing-stats-other@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'WS billing-stats-other',
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${otherAccess}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('APPLICATION_NOT_FOUND');
  });
});
