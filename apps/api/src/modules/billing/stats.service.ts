/**
 * Per-application billing/revenue stats for the operator panel's Billing
 * Overview tab, GET /tenant/applications/:id/billing/stats.
 *
 * Pure READ aggregations, computed on demand (operator page loads only,
 * same posture as `admin-metrics`). Everything is grouped/aggregated DB-side;
 * no per-row reads.
 *
 * MRR definition (mirrors `admin-metrics`'s computeMrrCents, scoped to one
 * app): sum of plan.amount over ACTIVE subscriptions, with YEAR plans
 * normalized to monthly via floor(amount / 12) per subscription. Only
 * `kind: SUBSCRIPTION` plans count, USAGE (metered), CREDIT (prepaid
 * packs) and LICENSE (one-time / perpetual key sales) aren't recurring
 * subscription revenue and are excluded.
 *
 * Currency: amounts in different currencies are never summed together. MRR
 * is computed per plan-currency and `mrrCents` reports the dominant currency
 * (largest MRR); `mixedCurrencies` flags when other currencies were present
 * so the panel can say the figure is partial.
 *
 * Scope: one Application. Isolation is the Application boundary, an app's
 * environment (PRODUCTION / STAGING / DEVELOPMENT) tells you how to read
 * these numbers, but it does not guarantee them: a development app may hold
 * live credentials, so check the credential mode rather than the environment
 * before treating a figure as sandbox.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { mrrByCurrency } from './mrr.js';
import { RekeyError } from '../../lib/error.js';
import { cachedSwr } from '../../lib/swr-cache.js';
import { dashboardBusy, dashboardSlots } from '../../lib/compute-semaphore.js';
import { withReadOnlyBudget } from '../../lib/read-budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Payments that still carry revenue; `refunded_amount` is netted off each. */
const REVENUE_STATUSES = ['SUCCEEDED', 'PARTIALLY_REFUNDED'] as const;

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
  /**
   * Net revenue of the last 30 days: payment amounts less what has been
   * refunded on them. A fully refunded payment counts nothing; a partly
   * refunded one counts what the buyer kept. Refunds net against the month
   * the payment was made in, not the month of the refund.
   */
  revenueLast30dCents: number;
  /** `succeeded` includes partly refunded payments. */
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

const BILLING_STATS_CACHE = { freshSeconds: 60, staleSeconds: 15 * 60 };

export function billingStatsCacheKey(applicationId: string): string {
  return `rk:billing-stats:app:${applicationId}`;
}

function billingStatsTimeout(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'ANALYTICS_TIMEOUT',
    message: 'The billing stats for this Application took longer than the query budget allows.',
    fix: 'Retry in a minute. If it keeps happening, report it with the Application id: its payment history has outgrown the stats query.',
    retryAfterSeconds: 60,
  });
}

export const billingStatsService = {
  /**
   * Cached like the Overview stats (lib/swr-cache.ts): fresh for 60s, then
   * served stale while one caller refreshes, computed read-only under a
   * statement timeout inside the shared dashboard slots.
   *
   * @example
   *   const stats = await billingStatsService.cached(applicationId);
   */
  async cached(applicationId: string): Promise<BillingStats> {
    const result = await cachedSwr(billingStatsCacheKey(applicationId), BILLING_STATS_CACHE, () =>
      dashboardSlots.run(() =>
        withReadOnlyBudget((tx) => this.forApplication(applicationId, tx), { onTimeout: billingStatsTimeout }),
      ),
    );
    if (result.status === 'pending') throw dashboardBusy();
    return result.value;
  },

  async forApplication(
    applicationId: string,
    db: Prisma.TransactionClient = prisma,
  ): Promise<BillingStats> {
    const since30d = new Date(Date.now() - 30 * DAY_MS);
    const seriesStart = utcMonthStart(REVENUE_MONTHS - 1);

    const [
      activeSubscriptions,
      pastDueSubscriptions,
      canceledLast30d,
      newSubscriptionsLast30d,
      revenueAgg,
      paymentsByStatus,
      monthlyRows,
    ] = await Promise.all([
      db.subscription.count({ where: { applicationId, status: 'ACTIVE' } }),
      db.subscription.count({ where: { applicationId, status: 'PAST_DUE' } }),
      db.subscription.count({
        where: { applicationId, status: 'CANCELED', canceledAt: { gte: since30d } },
      }),
      db.subscription.count({
        where: { applicationId, createdAt: { gte: since30d } },
      }),
      db.payment.aggregate({
        _sum: { amount: true, refundedAmount: true },
        where: { applicationId, status: { in: [...REVENUE_STATUSES] }, createdAt: { gte: since30d } },
      }),
      db.payment.groupBy({
        by: ['status'],
        where: { applicationId, createdAt: { gte: since30d } },
        _count: { _all: true },
      }),
      // Monthly net revenue, bucketed by UTC calendar month in SQL,
      // one round-trip, no row loading (same shape as the signup-trend query
      // in applications.service.ts). `created_at` is a naive timestamp stored
      // as UTC, so date_trunc buckets by UTC month directly.
      db.$queryRaw<Array<{ month: Date; total: bigint }>>(Prisma.sql`
        SELECT date_trunc('month', "created_at") AS month,
               SUM(amount - refunded_amount)::bigint AS total
        FROM "payments"
        WHERE "application_id" = ${applicationId}
          AND status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')
          AND "created_at" >= ${seriesStart}
        GROUP BY month
        ORDER BY month ASC
      `),
    ]);

    const mrr = await mrrByCurrency([applicationId], db);
    const dominant = mrr[0];
    const mrrCents = dominant?.mrrMinor ?? 0;
    const mrrCurrency = dominant && dominant.mrrMinor > 0 ? dominant.currency : null;
    const mixedCurrencies = mrr.length > 1;

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
      revenueLast30dCents: (revenueAgg._sum.amount ?? 0) - (revenueAgg._sum.refundedAmount ?? 0),
      paymentsLast30d: {
        succeeded: (statusMap.SUCCEEDED ?? 0) + (statusMap.PARTIALLY_REFUNDED ?? 0),
        failed: statusMap.FAILED ?? 0,
      },
      monthlyRevenue,
    };
  },
};
