/**
 * Monthly recurring revenue per currency, aggregated in SQL.
 *
 * The one MRR definition for an Application's Billing Overview and the
 * workspace overview: ACTIVE subscriptions on `SUBSCRIPTION` plans, a yearly
 * plan counted as `floor(amount / 12)` per subscription, never summed across
 * currencies. Each subscription counts at its own price. One with no price of
 * its own is left out, never counted at its plan's price: stats report it as
 * `unpricedLiveSubscriptions` when its plan has a flat price, and everywhere
 * else it reads as having no price. Grouped per plan and price in the
 * database, so the cost does not grow with the number of subscriptions and
 * nothing is capped.
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

/** What one ACTIVE subscription is worth per month, at its own price. */
const MONTHLY_VALUE = Prisma.sql`
  CASE WHEN p."interval" = 'YEAR' THEN floor(s."unit_amount" / 12.0) ELSE s."unit_amount" END`;

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
    SELECT upper(s."currency") AS currency,
           sum(${MONTHLY_VALUE} * s.n)::bigint AS mrr,
           sum(s.n)::bigint AS subs
      FROM (SELECT "plan_id", "currency", "unit_amount", count(*) AS n FROM "subscriptions"
             WHERE "application_id" = ANY(${[...applicationIds]}::text[]) AND "status" = 'ACTIVE'
             GROUP BY 1, 2, 3) AS s
      JOIN "plans" AS p ON p."id" = s."plan_id"
     WHERE p."kind" = 'SUBSCRIPTION' AND s."currency" IS NOT NULL
     GROUP BY 1
     ORDER BY 2 DESC, 1`);
  return rows.map((r) => ({ currency: r.currency, mrrMinor: Number(r.mrr), activeSubscriptions: Number(r.subs) }));
}

/**
 * The same MRR definition over every Application in the deployment, for the
 * super-admin overview. Ordered by subscription count, then currency: amounts
 * in different currencies cannot be ranked by size.
 *
 * @example
 *   const [largest, ...others] = await platformMrrByCurrency();
 */
export async function platformMrrByCurrency(db: Prisma.TransactionClient = prisma): Promise<CurrencyMrr[]> {
  const rows = await db.$queryRaw<Array<{ currency: string; mrr: bigint; subs: bigint }>>(Prisma.sql`
    SELECT upper(s."currency") AS currency,
           sum(${MONTHLY_VALUE} * s.n)::bigint AS mrr,
           sum(s.n)::bigint AS subs
      FROM (SELECT "plan_id", "currency", "unit_amount", count(*) AS n FROM "subscriptions"
             WHERE "status" = 'ACTIVE'
             GROUP BY 1, 2, 3) AS s
      JOIN "plans" AS p ON p."id" = s."plan_id"
     WHERE p."kind" = 'SUBSCRIPTION' AND s."currency" IS NOT NULL
     GROUP BY 1
     ORDER BY 3 DESC, 1`);
  return rows.map((r) => ({ currency: r.currency, mrrMinor: Number(r.mrr), activeSubscriptions: Number(r.subs) }));
}

export interface ApplicationCurrencyMrr extends CurrencyMrr {
  applicationId: string;
}

/**
 * The same MRR definition, one row per Application and currency, for lists
 * that show many Applications at once.
 *
 * @example
 *   const rows = await mrrByApplicationAndCurrency(applicationIds);
 */
export async function mrrByApplicationAndCurrency(
  applicationIds: readonly string[],
  db: Prisma.TransactionClient = prisma,
): Promise<ApplicationCurrencyMrr[]> {
  if (applicationIds.length === 0) return [];
  const rows = await db.$queryRaw<
    Array<{ application_id: string; currency: string; mrr: bigint; subs: bigint }>
  >(Prisma.sql`
    SELECT s."application_id",
           upper(s."currency") AS currency,
           sum(${MONTHLY_VALUE} * s.n)::bigint AS mrr,
           sum(s.n)::bigint AS subs
      FROM (SELECT "application_id", "plan_id", "currency", "unit_amount", count(*) AS n FROM "subscriptions"
             WHERE "application_id" = ANY(${[...applicationIds]}::text[]) AND "status" = 'ACTIVE'
             GROUP BY 1, 2, 3, 4) AS s
      JOIN "plans" AS p ON p."id" = s."plan_id"
     WHERE p."kind" = 'SUBSCRIPTION' AND s."currency" IS NOT NULL
     GROUP BY 1, 2
     ORDER BY 1, 4 DESC, 2`);
  return rows.map((r) => ({
    applicationId: r.application_id,
    currency: r.currency,
    mrrMinor: Number(r.mrr),
    activeSubscriptions: Number(r.subs),
  }));
}

/**
 * One page of tenant ids ordered by MRR in ONE currency, over every tenant.
 *
 * The order is decided in the database before the page is cut, so the first
 * page holds the largest tenants and not merely the largest of the newest.
 * A tenant with no MRR in the currency sorts as zero, and `id` breaks ties,
 * so the order is total and an offset never repeats or skips a tenant.
 * Amounts in other currencies take no part: they cannot be ranked against
 * these.
 *
 * With no `currency` named it ranks in the platform's headline currency, the
 * one with the most active subscriptions (ties by code), decided in the same
 * statement. `currency` in the answer is the one used: null when nothing on
 * the platform is recurring, and the order is then by id alone.
 *
 * @example
 *   const { currency, ids } = await tenantsRankedByMrr({ order: 'desc', limit: 50, offset: 0 });
 */
export async function tenantsRankedByMrr(
  args: {
    /** Upper-case ISO 4217. Left out, the platform's headline currency. */
    currency?: string | undefined;
    order: 'asc' | 'desc';
    limit: number;
    offset: number;
    /** Matches a tenant id exactly, or its name or owner email in part. */
    search?: string | undefined;
  },
  db: Prisma.TransactionClient = prisma,
): Promise<{ currency: string | null; ids: string[] }> {
  const direction = args.order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const like = args.search === undefined ? null : `%${args.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const matching =
    like === null
      ? Prisma.empty
      : Prisma.sql`WHERE t."id" = ${args.search} OR t."name" ILIKE ${like} OR t."owner_email" ILIKE ${like}`;
  const [row] = await db.$queryRaw<Array<{ currency: string | null; ids: string[] }>>(Prisma.sql`
    WITH priced AS (
      SELECT a."tenant_id",
             upper(s."currency") AS currency,
             ${MONTHLY_VALUE} * s.n AS mrr,
             s.n
        FROM (SELECT "application_id", "plan_id", "currency", "unit_amount", count(*) AS n FROM "subscriptions"
               WHERE "status" = 'ACTIVE'
               GROUP BY 1, 2, 3, 4) AS s
        JOIN "plans" AS p ON p."id" = s."plan_id"
        JOIN "applications" AS a ON a."id" = s."application_id"
       WHERE p."kind" = 'SUBSCRIPTION' AND s."currency" IS NOT NULL
    ), headline AS (
      SELECT coalesce(${args.currency ?? null}::text,
                      (SELECT currency FROM priced GROUP BY currency ORDER BY sum(n) DESC, currency LIMIT 1)) AS currency
    ), ranked AS (
      SELECT t."id", row_number() OVER (ORDER BY coalesce(m.mrr, 0) ${direction}, t."id" ${direction}) AS position
        FROM "tenants" AS t
        LEFT JOIN (SELECT priced."tenant_id", sum(priced.mrr)::bigint AS mrr
                     FROM priced JOIN headline ON headline.currency = priced.currency
                    GROUP BY priced."tenant_id") AS m ON m."tenant_id" = t."id"
        ${matching}
       ORDER BY coalesce(m.mrr, 0) ${direction}, t."id" ${direction}
       LIMIT ${args.limit} OFFSET ${args.offset}
    )
    SELECT (SELECT currency FROM headline) AS currency,
           coalesce((SELECT array_agg("id" ORDER BY position) FROM ranked), ARRAY[]::text[]) AS ids`);
  return { currency: row?.currency ?? null, ids: row?.ids ?? [] };
}
