/**
 * Monthly recurring revenue per currency, aggregated in SQL.
 *
 * The one MRR definition for an Application's Billing Overview and the
 * workspace overview: ACTIVE subscriptions on `SUBSCRIPTION` plans, a yearly
 * plan counted as `floor(amount / 12)` per subscription, never summed across
 * currencies. Grouped per plan in the database, so the cost does not grow
 * with the number of subscriptions and nothing is capped.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export interface CurrencyMrr {
  /** Upper-case ISO 4217. */
  currency: string;
  /** Smallest currency unit. */
  mrrMinor: number;
  activeSubscriptions: number;
}

/**
 * @example
 *   const perCurrency = await mrrByCurrency([applicationId]);
 */
export async function mrrByCurrency(
  applicationIds: readonly string[],
  db: Prisma.TransactionClient = prisma,
): Promise<CurrencyMrr[]> {
  if (applicationIds.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ currency: string; mrr: bigint; subs: bigint }>>(Prisma.sql`
    SELECT upper(p."currency") AS currency,
           sum(CASE WHEN p."interval" = 'YEAR' THEN floor(p."amount" / 12.0) ELSE p."amount" END * s.n)::bigint AS mrr,
           sum(s.n)::bigint AS subs
      FROM (SELECT "plan_id", count(*) AS n FROM "subscriptions"
             WHERE "application_id" = ANY(${[...applicationIds]}::text[]) AND "status" = 'ACTIVE'
             GROUP BY 1) AS s
      JOIN "plans" AS p ON p."id" = s."plan_id"
     WHERE p."kind" = 'SUBSCRIPTION'
     GROUP BY 1
     ORDER BY 2 DESC, 1`);
  return rows.map((r) => ({ currency: r.currency, mrrMinor: Number(r.mrr), activeSubscriptions: Number(r.subs) }));
}
