/**
 * One end user's part of the billing log: what erasure removes from it and
 * what a data export returns from it.
 *
 * The log holds no email, IP address or user agent. What it holds about a
 * person is where they were when they checked out: `data.buyerCountry` and
 * `data.buyerCountrySource`. Erasure nulls those two and keeps everything
 * else, so the amounts and ids of a payment stay on record and point at the
 * tombstone.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

type Db = Prisma.TransactionClient;

const NO_COUNTRY = { buyerCountry: null, buyerCountrySource: null };

/**
 * Null the personal fields of one end user's billing events, in the caller's
 * transaction, and of their events still waiting in the outbox. Returns how
 * many of each were changed.
 *
 * The log's trigger refuses an UPDATE unless the transaction has switched
 * maintenance on. The switch is set for this statement and cleared again, so
 * nothing later in the caller's transaction can change the log by accident.
 *
 * @example
 * await prisma.$transaction(async (tx) => {
 *   await eraseEndUserFromBillingLog(tx, { applicationId, endUserId });
 *   await tx.endUser.delete({ where: { id: endUserId } });
 * });
 */
export async function eraseEndUserFromBillingLog(
  tx: Db,
  args: { applicationId: string; endUserId: string },
): Promise<{ events: number; queued: number }> {
  const { applicationId, endUserId } = args;
  const cleared = JSON.stringify(NO_COUNTRY);
  // The outbox first. A drain that is moving one of these rows into the log
  // holds its row lock, so this waits for it, and the statement below then
  // sees the event that drain wrote.
  const queued = await tx.$executeRaw`
    UPDATE "billing_event_outbox"
       SET "payload" = jsonb_set("payload", '{data}', ("payload" -> 'data') || ${cleared}::jsonb)
     WHERE "application_id" = ${applicationId}
       AND "processed_at" IS NULL
       AND "payload" ->> 'endUserId' = ${endUserId}
       AND jsonb_typeof("payload" -> 'data') = 'object'
       AND (("payload" -> 'data' ->> 'buyerCountry') IS NOT NULL OR ("payload" -> 'data' ->> 'buyerCountrySource') IS NOT NULL)`;
  await tx.$executeRaw`SELECT set_config('rekey.billing_events_maintenance', 'on', true)`;
  const events = await tx.$executeRaw`
    UPDATE "billing_events"
       SET "data" = "data" || ${cleared}::jsonb
     WHERE "application_id" = ${applicationId}
       AND "end_user_id" = ${endUserId}
       AND (("data" ->> 'buyerCountry') IS NOT NULL OR ("data" ->> 'buyerCountrySource') IS NOT NULL)`;
  await tx.$executeRaw`SELECT set_config('rekey.billing_events_maintenance', 'off', true)`;
  return { events, queued };
}

/** A billing event as a data export carries it. The actor's id is left out: an operator's id is not the subject's data. */
export interface ExportedBillingEvent {
  id: string;
  type: string;
  occurredAt: string;
  actorType: string;
  subscriptionId: string | null;
  checkoutSessionId: string | null;
  paymentId: string | null;
  refundId: string | null;
  planId: string | null;
  planPriceId: string | null;
  couponId: string | null;
  provider: string | null;
  currency: string | null;
  amount: number | null;
  data: Prisma.JsonValue;
}

/**
 * The billing events about one end user, newest first, at most `cap`.
 *
 * @example
 * const billingEvents = await billingEventsForExport({ applicationId, endUserId, cap: 5000 });
 */
export async function billingEventsForExport(args: {
  applicationId: string;
  endUserId: string;
  cap: number;
}): Promise<ExportedBillingEvent[]> {
  const rows = await prisma.billingEvent.findMany({
    where: { applicationId: args.applicationId, endUserId: args.endUserId },
    select: {
      id: true,
      type: true,
      occurredAt: true,
      actorType: true,
      subscriptionId: true,
      checkoutSessionId: true,
      paymentId: true,
      refundId: true,
      planId: true,
      planPriceId: true,
      couponId: true,
      provider: true,
      currency: true,
      amount: true,
      data: true,
    },
    orderBy: { occurredAt: 'desc' },
    take: args.cap,
  });
  return rows.map((row) => ({ ...row, actorType: row.actorType.toLowerCase(), occurredAt: row.occurredAt.toISOString() }));
}
