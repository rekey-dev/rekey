/**
 * How often a buyer was charged the default price because the price selected
 * for them could not be charged, counted from the log.
 *
 * One fallback is a line in the log. A hundred of them is a market the
 * operator is mispricing without knowing, so they are counted per plan,
 * currency and country, where an operator edits prices.
 */

import { Prisma } from '@prisma/client';
import type { PriceFallbackSummary } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';

const MAX_GROUPS = 200;

/**
 * `checkout.price_fallback` events of one Application in a period, grouped by
 * plan, the currency asked for, the currency charged and the buyer's country.
 * One statement on the (application, type, seq) index. A country is null for
 * an erased buyer.
 *
 * @example
 * const { total, groups } = await priceFallbackSummary(applicationId, { from, to });
 * groups[0]; // { planSlug: 'pro', requestedCurrency: 'INR', chargedCurrency: 'USD', country: 'IN', count: 12, lastOccurredAt: '...' }
 */
export async function priceFallbackSummary(
  applicationId: string,
  period: { from: Date; to: Date },
  db: Prisma.TransactionClient = prisma,
): Promise<PriceFallbackSummary> {
  const rows = await db.$queryRaw<
    Array<{
      plan_slug: string | null;
      requested: string | null;
      charged: string | null;
      country: string | null;
      n: bigint;
      last_at: Date;
    }>
  >(Prisma.sql`
    SELECT "data" ->> 'planSlug' AS plan_slug,
           "data" -> 'requested' ->> 'currency' AS requested,
           "data" -> 'charged' ->> 'currency' AS charged,
           "data" ->> 'buyerCountry' AS country,
           count(*) AS n,
           max("occurred_at") AS last_at
      FROM "billing_events"
     WHERE "application_id" = ANY(${[applicationId]}::text[])
       AND "type" = 'checkout.price_fallback'
       AND "occurred_at" >= ${period.from} AND "occurred_at" < ${period.to}
     GROUP BY 1, 2, 3, 4
     ORDER BY count(*) DESC, 1, 2, 4
     LIMIT ${MAX_GROUPS}`);
  const groups = rows.map((row) => ({
    planSlug: row.plan_slug,
    requestedCurrency: row.requested,
    chargedCurrency: row.charged,
    country: row.country,
    count: Number(row.n),
    lastOccurredAt: row.last_at.toISOString(),
  }));
  return {
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  };
}
