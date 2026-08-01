/**
 * Per-application billing/revenue stats for the operator panel's Billing
 * Overview tab — GET /tenant/applications/:id/billing/stats.
 *
 * Pure READ aggregations, computed on demand (operator page loads only —
 * same posture as `admin-metrics`). Everything is grouped/aggregated DB-side;
 * no per-row reads.
 *
 * MRR definition (mirrors `admin-metrics`'s computeMrrCents, scoped to one
 * app): sum of plan.amount over ACTIVE subscriptions, with YEAR plans
 * normalized to monthly via floor(amount / 12) per subscription. Only
 * `kind: SUBSCRIPTION` plans count — USAGE (metered), CREDIT (prepaid
 * packs) and LICENSE (one-time / perpetual key sales) aren't recurring
 * subscription revenue and are excluded.
 *
 * Currency: amounts in different currencies are never summed together. MRR
 * is computed per plan-currency and `mrrCents` reports the dominant currency
 * (largest MRR); `mixedCurrencies` flags when other currencies were present
 * so the panel can say the figure is partial.
 *
 * Scope: one Application. Isolation is the Application boundary — an app's
 * environment (PRODUCTION / STAGING / DEVELOPMENT) tells you how to read
 * these numbers, but it does not guarantee them: a development app may hold
 * live credentials, so check the credential mode rather than the environment
 * before treating a figure as sandbox.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Months in the monthlyRevenue series (current month inclusive). */
const REVENUE_MONTHS = 12;

export interface BillingStats {
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  /** Subscriptions whose cancellation landed in the last 30 days. */
  canceledLast30d: number;
  /** Subscriptions created in the last 30 days (any status). */
  newSubscriptionsLast30d: number;
  /** Monthly recurring revenue, smallest currency unit. See module doc. */
  mrrCents: number;
  /** Currency of `mrrCents` (dominant across active plans); null when no MRR. */
  mrrCurrency: string | null;
  /** True when active SUBSCRIPTION plans span more than one currency. */
  mixedCurrencies: boolean;
  /** SUM(amount) of SUCCEEDED payments in the last 30 days. */
  revenueLast30dCents: number;
  paymentsLast30d: { succeeded: number; failed: number };
  /**
   * Last 12 UTC calendar months (oldest first, current month last),
   * gap-filled with zeroes. `month` is `YYYY-MM`.
   */
  monthlyRevenue: Array<{ month: string; amountCents: number }>;
}

/** First day (UTC midnight) of the month `monthsBack` months before now. */
function utcMonthStart(monthsBack: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
}

export const billingStatsService = {
  async forApplication(applicationId: string): Promise<BillingStats> {
    const since30d = new Date(Date.now() - 30 * DAY_MS);
    const seriesStart = utcMonthStart(REVENUE_MONTHS - 1);

    const [
      activeSubscriptions,
      pastDueSubscriptions,
      canceledLast30d,
      newSubscriptionsLast30d,
      activeByPlan,
      revenueAgg,
      paymentsByStatus,
      monthlyRows,
    ] = await Promise.all([
      prisma.subscription.count({ where: { applicationId, status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { applicationId, status: 'PAST_DUE' } }),
      prisma.subscription.count({
        where: { applicationId, status: 'CANCELED', canceledAt: { gte: since30d } },
      }),
      prisma.subscription.count({
        where: { applicationId, createdAt: { gte: since30d } },
      }),
      // MRR: one group per plan (bounded by the app's plan catalog), priced
      // below — never a per-subscription read.
      prisma.subscription.groupBy({
        by: ['planId'],
        where: { applicationId, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { applicationId, status: 'SUCCEEDED', createdAt: { gte: since30d } },
      }),
      prisma.payment.groupBy({
        by: ['status'],
        where: { applicationId, createdAt: { gte: since30d } },
        _count: { _all: true },
      }),
      // Monthly SUCCEEDED revenue, bucketed by UTC calendar month in SQL —
      // one round-trip, no row loading (same shape as the signup-trend query
      // in applications.service.ts). `created_at` is a naive timestamp stored
      // as UTC, so date_trunc buckets by UTC month directly.
      prisma.$queryRaw<Array<{ month: Date; total: bigint }>>(Prisma.sql`
        SELECT date_trunc('month', "created_at") AS month,
               SUM(amount)::bigint AS total
        FROM "payments"
        WHERE "application_id" = ${applicationId}
          AND status = 'SUCCEEDED'
          AND "created_at" >= ${seriesStart}
        GROUP BY month
        ORDER BY month ASC
      `),
    ]);

    // Price the per-plan ACTIVE groups. Bounded second query over the app's
    // plans that actually have active subs.
    const planIds = activeByPlan.map((g) => g.planId);
    const plans = planIds.length
      ? await prisma.plan.findMany({
          where: { id: { in: planIds } },
          select: { id: true, amount: true, interval: true, kind: true, currency: true },
        })
      : [];
    const planById = new Map(plans.map((p) => [p.id, p]));
    // Never sum across currencies — accumulate per currency, report the
    // dominant one and flag the rest (see module doc).
    const mrrByCurrency = new Map<string, number>();
    for (const g of activeByPlan) {
      const plan = planById.get(g.planId);
      if (!plan || plan.kind !== 'SUBSCRIPTION') continue;
      const monthly = plan.interval === 'YEAR' ? Math.floor(plan.amount / 12) : plan.amount;
      const currency = plan.currency.toUpperCase();
      mrrByCurrency.set(currency, (mrrByCurrency.get(currency) ?? 0) + monthly * g._count._all);
    }
    let mrrCents = 0;
    let mrrCurrency: string | null = null;
    for (const [currency, cents] of mrrByCurrency) {
      if (cents > mrrCents) {
        mrrCents = cents;
        mrrCurrency = currency;
      }
    }
    const mixedCurrencies = mrrByCurrency.size > 1;

    const statusMap = Object.fromEntries(
      paymentsByStatus.map((g) => [g.status, g._count._all]),
    ) as Record<string, number>;

    // Densify to one entry per month so the panel renders a gap-free chart
    // (months with no revenue become explicit zeroes).
    const byMonth = new Map<string, number>();
    for (const r of monthlyRows) {
      const d = new Date(r.month);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      byMonth.set(key, Number(r.total));
    }
    const monthlyRevenue: Array<{ month: string; amountCents: number }> = [];
    for (let i = REVENUE_MONTHS - 1; i >= 0; i--) {
      const d = utcMonthStart(i);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      monthlyRevenue.push({ month: key, amountCents: byMonth.get(key) ?? 0 });
    }

    return {
      activeSubscriptions,
      pastDueSubscriptions,
      canceledLast30d,
      newSubscriptionsLast30d,
      mrrCents,
      mrrCurrency,
      mixedCurrencies,
      revenueLast30dCents: revenueAgg._sum.amount ?? 0,
      paymentsLast30d: {
        succeeded: statusMap.SUCCEEDED ?? 0,
        failed: statusMap.FAILED ?? 0,
      },
      monthlyRevenue,
    };
  },
};
