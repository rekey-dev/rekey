/**
 * Tenant billing stats endpoint, GET /tenant/applications/:id/billing/stats.
 *
 * Seeds subscriptions + payments directly (deterministic dates) and asserts:
 *   - subscription counters (active / past-due / canceled+new in 30d),
 *   - MRR math: MONTH at face value, YEAR floored to /12, USAGE + CREDIT
 *     (non-recurring) plans excluded,
 *   - 30-day payment volume + succeeded/failed counts,
 *   - the 12-month UTC monthly-revenue series (gap-filled, window-clipped),
 *   - workspace scoping (404 from another tenant).
 */

import { billingStatsService } from '../src/modules/billing/stats.service.js';
import { mrrByCurrency } from '../src/modules/billing/mrr.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { pricedAt } from './subscription-price-fixture.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface BillingStats {
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  canceledLast30d: number;
  newSubscriptionsLast30d: number;
  reportingCurrency: string;
  mrr: Array<{ currency: string; mrrCents: number; activeSubscriptions: number }>;
  revenueLast30d: Array<{ currency: string; grossCents: number; refundedCents: number; netCents: number; payments: number }>;
  paymentsLast30d: { succeeded: number; failed: number };
  monthlyRevenue: Array<{ currency: string; months: Array<{ month: string; amountCents: number }> }>;
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

    // One end-user per subscription, (applicationId, endUserId, planId) is unique.
    const eu = async (n: number): Promise<string> =>
      (await prisma.endUser.create({ data: { applicationId, email: `bs-${n}@example.com` } })).id;

    // ---- subscriptions ------------------------------------------------
    // ACTIVE: 2× monthly (1000 each) + 1× yearly (833) + credit + usage
    // (excluded from MRR) → MRR = 2833, activeSubscriptions = 5. Each of the
    // three carries its own price, which is what MRR reads.
    const monthlyPrice = await pricedAt(monthly.id, 'USD', 1000);
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(1), planId: monthly.id, status: 'ACTIVE', ...monthlyPrice } });
    await prisma.subscription.create({ data: { applicationId, endUserId: await eu(2), planId: monthly.id, status: 'ACTIVE', ...monthlyPrice } });
    await prisma.subscription.create({
      data: { applicationId, endUserId: await eu(3), planId: yearly.id, status: 'ACTIVE', ...(await pricedAt(yearly.id, 'USD', 10000)) },
    });
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
    expect(res.statusCode, res.body).toBe(200);
    const stats = res.json().data as BillingStats;

    expect(stats.activeSubscriptions).toBe(5);
    expect(stats.pastDueSubscriptions).toBe(1);
    expect(stats.canceledLast30d).toBe(1);
    // Everything seeded "now" except the backdated old-canceled row: 5 active
    // + 1 past-due + 1 recent-canceled = 7.
    expect(stats.newSubscriptionsLast30d).toBe(7);
    // 2×1000 (MONTH) + floor(10000/12)=833 (YEAR), CREDIT + USAGE excluded.
    expect(stats.reportingCurrency).toBe('USD');
    expect(stats.mrr).toEqual([{ currency: 'USD', mrrCents: 2833, activeSubscriptions: 3 }]);
  });

  it('never sums MRR across currencies: each currency is its own entry', async () => {
    // Add an EUR plan with one active sub (500/mo). USD MRR (2833) dominates.
    const eurPlan = await prisma.plan.create({
      data: { applicationId, slug: 'pro_eur', name: 'Pro EUR', amount: 500, currency: 'EUR', interval: 'MONTH', kind: 'SUBSCRIPTION' },
    });
    const euUser = await prisma.endUser.create({ data: { applicationId, email: 'bs-eur@example.com' } });
    await prisma.subscription.create({
      data: { applicationId, endUserId: euUser.id, planId: eurPlan.id, status: 'ACTIVE', ...(await pricedAt(eurPlan.id, 'EUR', 500)) },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    const stats = res.json().data as BillingStats;

    // Side by side, NOT 2833 + 500 anywhere.
    expect(stats.mrr).toEqual([
      { currency: 'USD', mrrCents: 2833, activeSubscriptions: 3 },
      { currency: 'EUR', mrrCents: 500, activeSubscriptions: 1 },
    ]);
    expect(JSON.stringify(stats)).not.toContain('3333');
  });

  it('counts a subscription at its own price, not at whatever its plan costs today', async () => {
    // One of the two monthly subscribers pays 400 in INR: a second currency on
    // the same plan. The USD total loses them and INR appears beside it.
    const monthly = await prisma.plan.findFirstOrThrow({ where: { applicationId, interval: 'MONTH', kind: 'SUBSCRIPTION', amount: 1000 } });
    const one = await prisma.subscription.findFirstOrThrow({ where: { applicationId, planId: monthly.id, status: 'ACTIVE' } });
    await prisma.subscription.update({ where: { id: one.id }, data: await pricedAt(monthly.id, 'INR', 400) });

    const perCurrency = await mrrByCurrency([applicationId]);
    expect(perCurrency).toEqual([
      { currency: 'USD', mrrMinor: 1833, activeSubscriptions: 2 },
      { currency: 'INR', mrrMinor: 400, activeSubscriptions: 1 },
    ]);
  });

  it('leaves an ACTIVE subscription with no price of its own out of MRR, and counts it as unpriced', async () => {
    const unpricedNow = async (): Promise<number> =>
      (await billingStatsService.forApplication(applicationId)).unpricedLiveSubscriptions;
    const before = await unpricedNow();
    const monthly = await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: 'pro_m' } });
    const buyer = await prisma.endUser.create({ data: { applicationId, email: 'bs-unpriced@example.com' } });
    await prisma.subscription.create({ data: { applicationId, endUserId: buyer.id, planId: monthly.id, status: 'ACTIVE' } });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const stats = res.json().data as BillingStats & { unpricedLiveSubscriptions: number };
    // Not at the plan's 1000: the fourth subscriber is one more in the unpriced count and nowhere in MRR.
    expect(stats.mrr).toEqual([{ currency: 'USD', mrrCents: 2833, activeSubscriptions: 3 }]);
    expect(stats.activeSubscriptions).toBe(6);
    expect(stats.unpricedLiveSubscriptions).toBe(before + 1);
  });

  it('aggregates 30-day payment volume and succeeded/failed counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    const stats = res.json().data as BillingStats;

    // 1500 + 2500
    expect(stats.revenueLast30d).toEqual([{ currency: 'USD', grossCents: 4000, refundedCents: 0, netCents: 4000, payments: 2 }]);
    expect(stats.paymentsLast30d.succeeded).toBe(2);
    expect(stats.paymentsLast30d.failed).toBe(1);
  });

  it('never adds revenue across currencies: the reporting currency is first and the rest is listed', async () => {
    // A rupee total is a far larger number than the same money in dollars, so
    // size must not decide which currency the page is in.
    await prisma.payment.create({
      data: { applicationId, amount: 300000, currency: 'inr', status: 'SUCCEEDED', createdAt: new Date(Date.now() - 1 * DAY_MS) },
    });
    // The same currency in another case is the same currency.
    await prisma.payment.create({
      data: { applicationId, amount: 100, currency: 'usd', status: 'SUCCEEDED', createdAt: new Date(Date.now() - 1 * DAY_MS) },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    const stats = res.json().data as BillingStats;

    expect(stats.revenueLast30d.map((r) => [r.currency, r.netCents, r.payments])).toEqual([
      ['USD', 4100, 3],
      ['INR', 300000, 1],
    ]);
    expect(stats.monthlyRevenue.map((s) => s.currency)).toEqual(['USD', 'INR']);
    expect(stats.monthlyRevenue[0]!.months.reduce((sum, m) => sum + m.amountCents, 0)).toBe(4100 + 7000);
    expect(stats.monthlyRevenue[1]!.months.reduce((sum, m) => sum + m.amountCents, 0)).toBe(300000);
  });

  it('keeps the reporting currency first at zero when all the revenue is in other currencies', async () => {
    await prisma.payment.deleteMany({ where: { applicationId } });
    for (const amount of [500, 700]) {
      await prisma.payment.create({ data: { applicationId, amount, currency: 'EUR', status: 'SUCCEEDED', createdAt: new Date(Date.now() - DAY_MS) } });
    }
    await prisma.payment.create({ data: { applicationId, amount: 900000, currency: 'INR', status: 'SUCCEEDED', createdAt: new Date(Date.now() - DAY_MS) } });
    const stats = await billingStatsService.forApplication(applicationId);
    // The operator's choice leads, not whichever currency has the most rows or the largest number.
    expect(stats.revenueLast30d.map((r) => [r.currency, r.netCents])).toEqual([
      ['USD', 0],
      ['EUR', 1200],
      ['INR', 900000],
    ]);
  });

  it('reports only the reporting currency, at zero, with no payments', async () => {
    await prisma.payment.deleteMany({ where: { applicationId } });
    await prisma.subscription.deleteMany({ where: { applicationId } });
    const empty = await billingStatsService.forApplication(applicationId);
    expect(empty.mrr).toEqual([{ currency: 'USD', mrrCents: 0, activeSubscriptions: 0 }]);
    expect(empty.revenueLast30d).toEqual([{ currency: 'USD', grossCents: 0, refundedCents: 0, netCents: 0, payments: 0 }]);
    expect(empty.monthlyRevenue).toHaveLength(1);
    expect(empty.monthlyRevenue[0]!.months.every((m) => m.amountCents === 0)).toBe(true);
  });

  it('buckets SUCCEEDED revenue into 12 gap-filled UTC months', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    const stats = res.json().data as BillingStats;

    expect(stats.monthlyRevenue.map((s) => s.currency)).toEqual(['USD']);
    const months = stats.monthlyRevenue[0]!.months;
    expect(months).toHaveLength(12);
    // Oldest-first, current month last.
    expect(months[11]!.month).toBe(monthRef(0).key);
    expect(months[0]!.month).toBe(monthRef(11).key);

    // The 7000 payment lands in its month's bucket, alone (the FAILED 4242 in
    // the same month is excluded, the recent ones can't be 2 months back).
    const twoBack = months.find((m) => m.month === monthRef(2).key);
    expect(twoBack?.amountCents).toBe(7000);

    // Series total = recent SUCCEEDED (4000) + 7000; the 13-months-back 11111
    // is clipped by the window, FAILED rows never count.
    const total = months.reduce((s, m) => s + m.amountCents, 0);
    expect(total).toBe(11000);

    // Gap-filling: every month key present exactly once, in order.
    const keys = months.map((m) => m.month);
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
