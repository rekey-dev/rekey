/**
 * Reads one Application's billing log, newest first.
 *
 * Pages are cut on `seq`, never on an offset: an event written while a reader
 * is paging gets a larger `seq` than everything already returned, so it can
 * neither repeat an entry nor push one off the next page. The Application is
 * part of every query, which is what keeps one workspace out of another's
 * log whatever ids the filters carry.
 */

import { Prisma, type BillingEvent as BillingEventRow } from '@prisma/client';
import type { BillingEventTier, BillingEventType, BillingLogEntry } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';

export interface BillingLogFilter {
  applicationId: string;
  limit: number;
  /** Return entries with a smaller `seq` than this: the previous page's `nextCursor`. */
  cursor?: string | undefined;
  types?: readonly BillingEventType[] | undefined;
  tier?: BillingEventTier | undefined;
  endUserId?: string | undefined;
  subscriptionId?: string | undefined;
  paymentId?: string | undefined;
  currency?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/** The stored entries of one page, before anyone they name is looked up. */
export interface BillingLogRead {
  items: BillingLogEntry[];
  nextCursor: string | null;
}

const ACTOR_TYPE = { SYSTEM: 'system', OPERATOR: 'operator', END_USER: 'end_user', PROVIDER: 'provider' } as const;

/**
 * A stored event as the API returns it. `seq` is a 64-bit integer, which JSON
 * cannot carry, so it leaves as a string. The dedupe key stays behind: it is
 * how a write is recognised as a repeat and says nothing to a reader.
 *
 * @example
 * return { success: true, data: rows.map(toBillingLogEntry) };
 */
export function toBillingLogEntry(row: BillingEventRow): BillingLogEntry {
  return {
    id: row.id,
    seq: row.seq.toString(),
    applicationId: row.applicationId,
    type: row.type,
    tier: row.tier,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    actor: { type: ACTOR_TYPE[row.actorType], id: row.actorId },
    endUserId: row.endUserId,
    subscriptionId: row.subscriptionId,
    checkoutSessionId: row.checkoutSessionId,
    paymentId: row.paymentId,
    refundId: row.refundId,
    planId: row.planId,
    planPriceId: row.planPriceId,
    couponId: row.couponId,
    provider: row.provider,
    providerEventId: row.providerEventId,
    currency: row.currency,
    amount: row.amount,
    data: row.data,
    // Each row was validated against the union for its type when it was
    // written, which is what this narrowing relies on.
  } as BillingLogEntry;
}

interface SqlRow {
  id: string;
  seq: bigint;
  application_id: string;
  type: string;
  tier: BillingEventRow['tier'];
  occurred_at: Date;
  recorded_at: Date;
  dedupe_key: string;
  actor_type: BillingEventRow['actorType'];
  actor_id: string | null;
  end_user_id: string | null;
  subscription_id: string | null;
  checkout_session_id: string | null;
  payment_id: string | null;
  refund_id: string | null;
  plan_id: string | null;
  plan_price_id: string | null;
  coupon_id: string | null;
  provider: string | null;
  provider_event_id: string | null;
  currency: string | null;
  amount: number | null;
  data: Prisma.JsonValue;
}

function fromSql(row: SqlRow): BillingEventRow {
  return {
    id: row.id,
    seq: row.seq,
    applicationId: row.application_id,
    type: row.type,
    tier: row.tier,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    dedupeKey: row.dedupe_key,
    actorType: row.actor_type,
    actorId: row.actor_id,
    endUserId: row.end_user_id,
    subscriptionId: row.subscription_id,
    checkoutSessionId: row.checkout_session_id,
    paymentId: row.payment_id,
    refundId: row.refund_id,
    planId: row.plan_id,
    planPriceId: row.plan_price_id,
    couponId: row.coupon_id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    currency: row.currency,
    amount: row.amount,
    data: row.data,
  };
}

/**
 * One branch of the read: this Application's events that pass the filters,
 * newest first, optionally of one type.
 *
 * The Application is written as `= ANY(array)` and the order names
 * `application_id` first, both on purpose. `seq` is unique across the whole
 * table, and with a plain `application_id = $1 ORDER BY seq` Postgres walks
 * that global index backwards and discards other Applications' rows until the
 * page is full. When the filter matches nothing here, that is every event of
 * every Application (measured: 200,002 rows discarded on a 200,000-row table).
 * In this form only an index that starts with `application_id` can give the
 * order, so a read costs what this Application's own log costs and nothing
 * more.
 */
function branch(filter: BillingLogFilter, type: BillingEventType | null): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`"application_id" = ANY(${[filter.applicationId]}::text[])`];
  if (type !== null) conditions.push(Prisma.sql`"type" = ${type}`);
  if (filter.cursor !== undefined) conditions.push(Prisma.sql`"seq" < ${BigInt(filter.cursor)}`);
  if (filter.tier !== undefined) conditions.push(Prisma.sql`"tier" = ${filter.tier}::"BillingEventTier"`);
  if (filter.endUserId !== undefined) conditions.push(Prisma.sql`"end_user_id" = ${filter.endUserId}`);
  if (filter.subscriptionId !== undefined) conditions.push(Prisma.sql`"subscription_id" = ${filter.subscriptionId}`);
  if (filter.paymentId !== undefined) conditions.push(Prisma.sql`"payment_id" = ${filter.paymentId}`);
  if (filter.currency !== undefined) conditions.push(Prisma.sql`"currency" = ${filter.currency}`);
  if (filter.from !== undefined) conditions.push(Prisma.sql`"occurred_at" >= ${filter.from}`);
  if (filter.to !== undefined) conditions.push(Prisma.sql`"occurred_at" < ${filter.to}`);
  return Prisma.sql`
    SELECT * FROM "billing_events"
     WHERE ${Prisma.join(conditions, ' AND ')}
     ORDER BY "application_id" DESC, "seq" DESC
     LIMIT ${filter.limit + 1}`;
}

/**
 * One page of an Application's log: one statement, whatever the page size.
 *
 * Several types are read as one branch per type, each on the
 * (application, type, seq) index, and merged: a single `type IN (...)` cannot
 * be read in `seq` order from that index.
 *
 * @example
 * const page = await readBillingLog({ applicationId, limit: 50, subscriptionId });
 * const next = page.nextCursor === null ? null : await readBillingLog({ applicationId, limit: 50, subscriptionId, cursor: page.nextCursor });
 */
export async function readBillingLog(
  filter: BillingLogFilter,
  db: Prisma.TransactionClient = prisma,
): Promise<BillingLogRead> {
  const types = filter.types === undefined ? [null] : [...new Set(filter.types)];
  // One more than asked for says whether another page exists without a count.
  const query =
    types.length === 1
      ? branch(filter, types[0] ?? null)
      : Prisma.sql`
          SELECT * FROM (${Prisma.join(
            types.map((type) => Prisma.sql`(${branch(filter, type)})`),
            ' UNION ALL ',
          )}) AS merged
           ORDER BY "seq" DESC
           LIMIT ${filter.limit + 1}`;
  const rows = (await db.$queryRaw<SqlRow[]>(query)).map(fromSql);
  const page = rows.slice(0, filter.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toBillingLogEntry),
    nextCursor: rows.length > filter.limit && last !== undefined ? last.seq.toString() : null,
  };
}
