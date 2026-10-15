/**
 * What is waiting in the billing-event outbox, for the super-admin.
 *
 * A row that keeps failing is an event that is missing from an Application's
 * log. Nothing else reports it: the drain logs a warning and tries again
 * later, for ever.
 */

import { Prisma } from '@prisma/client';
import type { BillingOutboxStatus } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';

/**
 * A row that has failed this many times is reported as stuck. The first
 * retries are a minute, two and four apart; the fifth failure is about a
 * quarter of an hour in.
 */
export const OUTBOX_FAILING_ATTEMPTS = 5;
const STUCK_LISTED = 100;

/**
 * Counts of the outbox and its stuck rows: two queries, whatever it holds.
 * No payload is returned, only the type it names.
 *
 * @example
 * const { failing, stuck } = await billingOutboxStatus();
 */
export async function billingOutboxStatus(now: Date = new Date()): Promise<BillingOutboxStatus> {
  const [counts] = await prisma.$queryRaw<
    Array<{ pending: bigint; due: bigint; failing: bigint; oldest: Date | null }>
  >(Prisma.sql`
    SELECT count(*) AS pending,
           count(*) FILTER (WHERE "next_attempt_at" <= ${now}) AS due,
           count(*) FILTER (WHERE "attempts" >= ${OUTBOX_FAILING_ATTEMPTS}) AS failing,
           min("created_at") AS oldest
      FROM "billing_event_outbox"
     WHERE "processed_at" IS NULL`);
  const stuck = await prisma.$queryRaw<
    Array<{ id: string; application_id: string; type: string | null; attempts: number; last_error: string | null; created_at: Date; next_attempt_at: Date }>
  >(Prisma.sql`
    SELECT "id", "application_id", "payload" ->> 'type' AS type, "attempts", "last_error", "created_at", "next_attempt_at"
      FROM "billing_event_outbox"
     WHERE "processed_at" IS NULL AND "attempts" >= ${OUTBOX_FAILING_ATTEMPTS}
     ORDER BY "attempts" DESC, "created_at", "id"
     LIMIT ${STUCK_LISTED}`);
  return {
    pending: Number(counts?.pending ?? 0),
    due: Number(counts?.due ?? 0),
    failing: Number(counts?.failing ?? 0),
    failingThreshold: OUTBOX_FAILING_ATTEMPTS,
    oldestPendingAt: counts?.oldest?.toISOString() ?? null,
    stuck: stuck.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      type: row.type,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      nextAttemptAt: row.next_attempt_at.toISOString(),
    })),
  };
}
