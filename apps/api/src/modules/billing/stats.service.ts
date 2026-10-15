/**
 * Per-application billing/revenue stats for the operator panel's Billing
 * Overview tab, GET /tenant/applications/:id/billing/stats.
 *
 * Pure READ aggregations, computed on demand (operator page loads only,
 * same posture as `admin-metrics`). Everything is grouped/aggregated DB-side;
 * no per-row reads.
 *
 * MRR definition (billing/mrr.ts, scoped to one app): every ACTIVE
 * subscription at its own price, or its plan's where it has none, with YEAR
 * plans normalized to monthly via floor(amount / 12) per subscription. Only
 * `kind: SUBSCRIPTION` plans count, USAGE (metered), CREDIT (prepaid
 * packs) and LICENSE (one-time / perpetual key sales) aren't recurring
 * subscription revenue and are excluded.
 *
 * Currency: every money figure is a list with one entry per currency, and no
 * code here adds an amount in one currency to an amount in another. There is
 * no converted total. The Application's reporting currency is always the
 * first entry, at zero when it has nothing, so the headline a page shows is
 * the one the operator chose and not whichever currency happened to be
 * largest; the others follow by code.
 *
 * Refunds: revenue is net. What was refunded on a payment is taken off the
 * day and month of that payment, not the day of the refund, so a month's
 * figure can fall after the month ends.
 *
 * Verification: revenue counts VERIFIED payments only. A charge Rekey
 * recorded and did not apply is money the operator has not accounted for
 * yet, so it is reported on its own in `unverified` and joins revenue when
 * the operator applies it.
 *
 * Scope: one Application. Isolation is the Application boundary, an app's
 * environment (PRODUCTION / STAGING / DEVELOPMENT) tells you how to read
 * these numbers, but it does not guarantee them: a development app may hold
 * live credentials, so check the credential mode rather than the environment
 * before treating a figure as sandbox.
 */

import { Prisma } from '@prisma/client';
import {
  ENTITLING_SUBSCRIPTION_STATUSES,
  type BillingStatsDto,
  type CurrencyMrrDto,
  type CurrencyRevenueDto,
  type CurrencyUnverifiedDto,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { mrrByCurrency } from './mrr.js';
import { reportingCurrency } from './reporting-currency.js';
import { billingStatsCacheKey } from './stats-cache-key.js';
import { RekeyError } from '../../lib/error.js';
import { cachedSwr } from '../../lib/swr-cache.js';
import { dashboardBusy, dashboardSlots } from '../../lib/compute-semaphore.js';
import { withReadOnlyBudget } from '../../lib/read-budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Months in the monthlyRevenue series (current month inclusive). */
const REVENUE_MONTHS = 12;

export type BillingStats = BillingStatsDto;

/** First day (UTC midnight) of the month `monthsBack` months before now. */
function utcMonthStart(monthsBack: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
}

const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * One entry per currency, the reporting currency first and the others by
 * code. The reporting currency gets `empty` when nothing is in it.
 *
 * @example
 * reportingFirst([{ currency: 'INR', n: 2 }], 'USD', (currency) => ({ currency, n: 0 }));
 * // [{ currency: 'USD', n: 0 }, { currency: 'INR', n: 2 }]
 */
export function reportingFirst<T extends { currency: string }>(
  entries: readonly T[],
  reporting: string,
  empty: (currency: string) => T,
): T[] {
  const own = entries.find((entry) => entry.currency === reporting) ?? empty(reporting);
  const others = entries
    .filter((entry) => entry.currency !== reporting)
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  return [own, ...others];
}

const BILLING_STATS_CACHE = { freshSeconds: 60, staleSeconds: 15 * 60 };

export { billingStatsCacheKey };

function billingStatsTimeout(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'ANALYTICS_TIMEOUT',
    message: 'The billing stats for this Application took longer than the query budget allows.',
    fix: 'Retry in a minute. If it keeps happening, report it with the Application id: its payment history has outgrown the stats query.',
    retryAfterSeconds: 60,
  });
}

/**
 * What a payment contributes: charged, and given back. A fully refunded
 * payment gave back all of it, whatever its `refunded_amount` says: rows
 * refunded before that column existed carry zero there.
 */
const REFUNDED = Prisma.sql`CASE WHEN "status" = 'REFUNDED' THEN "amount" ELSE "refunded_amount" END`;
const CHARGED_STATUSES = Prisma.sql`('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')`;

/**
 * Unverified money still held by one Application, per currency, net of
 * refunds. A fully refunded payment holds nothing.
 *
 * @example
 * await unverifiedByCurrency(prisma, applicationId);
 * // [{ currency: 'INR', amountCents: 149900, payments: 1 }]
 */
export async function unverifiedByCurrency(db: Prisma.TransactionClient, applicationId: string): Promise<CurrencyUnverifiedDto[]> {
  const rows = await db.$queryRaw<Array<{ currency: string; amount: bigint; payments: bigint }>>(Prisma.sql`
    SELECT upper("currency") AS currency,
           sum("amount" - "refunded_amount")::bigint AS amount,
           count(*)::bigint AS payments
      FROM "payments"
     WHERE "application_id" = ${applicationId}
       AND "verification" = 'UNVERIFIED'
       AND "status" IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')
     GROUP BY 1
     ORDER BY 1
  `);
  return rows
    .filter((row) => row.currency !== '')
    .map((row) => ({ currency: row.currency, amountCents: Number(row.amount), payments: Number(row.payments) }));
}

/**
 * Live subscriptions of one Application with no price of their own, on a
 * plan that has a flat price. A subscription to a plan with no flat price (a
 * free plan, a usage plan with no base fee) is not counted: it has no price
 * by design.
 *
 * @example
 * await unpricedLiveSubscriptions(prisma, applicationId); // 0 on a healthy Application
 */
export function unpricedLiveSubscriptions(db: Prisma.TransactionClient, applicationId: string): Promise<number> {
  return db.subscription.count({
    where: {
      applicationId,
      status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] },
      currency: null,
      plan: { defaultPriceId: { not: null } },
    },
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
      revenueRows,
      paymentsByStatus,
      monthlyRows,
      application,
      unverifiedRows,
      unpriced,
    ] = await Promise.all([
      db.subscription.count({ where: { applicationId, status: 'ACTIVE' } }),
      db.subscription.count({ where: { applicationId, status: 'PAST_DUE' } }),
      db.subscription.count({
        where: { applicationId, status: 'CANCELED', canceledAt: { gte: since30d } },
      }),
      db.subscription.count({
        where: { applicationId, createdAt: { gte: since30d } },
      }),
      db.$queryRaw<Array<{ currency: string; gross: bigint; refunded: bigint; payments: bigint }>>(Prisma.sql`
        SELECT upper("currency") AS currency,
               sum("amount")::bigint AS gross,
               sum(${REFUNDED})::bigint AS refunded,
               count(*)::bigint AS payments
        FROM "payments"
        WHERE "application_id" = ${applicationId}
          AND "status" IN ${CHARGED_STATUSES}
          AND "verification" = 'VERIFIED'
          AND "created_at" >= ${since30d}
        GROUP BY 1
      `),
      db.payment.groupBy({
        by: ['status'],
        where: { applicationId, createdAt: { gte: since30d } },
        _count: { _all: true },
      }),
      // Monthly net revenue per currency, bucketed by UTC calendar month in
      // SQL: one round-trip, no row loading. `created_at` is a naive
      // timestamp stored as UTC, so date_trunc buckets by UTC month directly.
      db.$queryRaw<Array<{ month: Date; currency: string; total: bigint }>>(Prisma.sql`
        SELECT date_trunc('month', "created_at") AS month,
               upper("currency") AS currency,
               sum("amount" - ${REFUNDED})::bigint AS total
        FROM "payments"
        WHERE "application_id" = ${applicationId}
          AND "status" IN ${CHARGED_STATUSES}
          AND "verification" = 'VERIFIED'
          AND "created_at" >= ${seriesStart}
        GROUP BY 1, 2
      `),
      db.application.findUnique({ where: { id: applicationId }, select: { billingConfig: true } }),
      unverifiedByCurrency(db, applicationId),
      unpricedLiveSubscriptions(db, applicationId),
    ]);

    const reporting = reportingCurrency({ billingConfig: application?.billingConfig ?? {} });

    const mrr = reportingFirst<CurrencyMrrDto>(
      (await mrrByCurrency([applicationId], db)).map((m) => ({
        currency: m.currency,
        mrrCents: m.mrrMinor,
        activeSubscriptions: m.activeSubscriptions,
      })),
      reporting,
      (currency) => ({ currency, mrrCents: 0, activeSubscriptions: 0 }),
    );

    const revenueLast30d = reportingFirst<CurrencyRevenueDto>(
      revenueRows
        .filter((row) => row.currency !== '')
        .map((row) => ({
          currency: row.currency,
          grossCents: Number(row.gross),
          refundedCents: Number(row.refunded),
          netCents: Number(row.gross) - Number(row.refunded),
          payments: Number(row.payments),
        })),
      reporting,
      (currency) => ({ currency, grossCents: 0, refundedCents: 0, netCents: 0, payments: 0 }),
    );

    // One series per currency, each densified to one entry per month so the
    // panel renders a gap-free chart (months with no revenue are zeroes).
    const byCurrency = new Map<string, Map<string, number>>();
    for (const row of monthlyRows) {
      if (row.currency === '') continue;
      const months = byCurrency.get(row.currency) ?? new Map<string, number>();
      months.set(monthKey(new Date(row.month)), Number(row.total));
      byCurrency.set(row.currency, months);
    }
    const series = (months: Map<string, number> | undefined): Array<{ month: string; amountCents: number }> => {
      const out: Array<{ month: string; amountCents: number }> = [];
      for (let i = REVENUE_MONTHS - 1; i >= 0; i--) {
        const key = monthKey(utcMonthStart(i));
        out.push({ month: key, amountCents: months?.get(key) ?? 0 });
      }
      return out;
    };
    const monthlyRevenue = reportingFirst(
      [...byCurrency.entries()].map(([currency, months]) => ({ currency, months: series(months) })),
      reporting,
      (currency) => ({ currency, months: series(undefined) }),
    );

    const unverified = [...unverifiedRows].sort((a, b) => Number(b.currency === reporting) - Number(a.currency === reporting));

    const statusMap = Object.fromEntries(
      paymentsByStatus.map((g) => [g.status, g._count._all]),
    ) as Record<string, number>;

    return {
      activeSubscriptions,
      pastDueSubscriptions,
      canceledLast30d,
      newSubscriptionsLast30d,
      unpricedLiveSubscriptions: unpriced,
      reportingCurrency: reporting,
      mrr,
      revenueLast30d,
      unverified,
      // Every payment recorded, verified or not: what the providers reported,
      // not what counted as revenue. Unverified money is in `unverified`.
      paymentsLast30d: {
        succeeded: (statusMap.SUCCEEDED ?? 0) + (statusMap.PARTIALLY_REFUNDED ?? 0),
        failed: statusMap.FAILED ?? 0,
      },
      monthlyRevenue,
    };
  },
};
