/**
 * Drains the billing-event outbox into the billing log.
 *
 * The database is the source of truth: a row stays unprocessed until its
 * event is in the log. The BullMQ job only makes that happen sooner, and the
 * poller in app.ts (`pollBillingEventOutbox`) drains whatever a lost job left
 * behind. Any number of
 * drains may overlap, because each event is deduplicated on a key of its own.
 */

import { Prisma } from '@prisma/client';
import { BillingEventSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { admitDiagnosticEvent } from './diagnostic-bound.js';
import { toBillingEventRow } from './events.js';
import type { BillingLogLogger } from './writer.js';

const DEFAULT_BATCH = 100;
/** A processed row is kept this long, as a record of what was queued and when. */
const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many processed rows are pruned per drain, so a backlog cannot stall one. */
const PRUNE_BATCH = 500;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const LAST_ERROR_MAX = 500;

/**
 * How long a row that has failed `attempts` times waits before the next try:
 * a minute, doubling, capped at six hours.
 *
 * @example
 * retryDelayMs(1); // 60000
 * retryDelayMs(4); // 480000
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

/**
 * Move up to `limit` queued events into the log, oldest first, then prune
 * rows processed long ago. Returns how many events were settled.
 *
 * A payload this build's schema refuses is NOT settled. During a rolling
 * deploy an older build drains events a newer one queued, and marking those
 * processed would discard them. The row keeps its payload, records the
 * failure and waits for a build that can read it. Rows behind it are not held
 * up: a failed row is skipped until its next attempt is due.
 *
 * @example
 * const settled = await drainBillingEventOutbox(100, app.log);
 */
export async function drainBillingEventOutbox(limit = DEFAULT_BATCH, log?: BillingLogLogger): Promise<number> {
  const now = new Date();
  const pending = await prisma.billingEventOutbox.findMany({
    where: { processedAt: null, nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let settled = 0;
  for (const row of pending) {
    settled += await prisma.$transaction(async (tx) => {
      // Read again under the row lock. Erasing an end user rewrites the
      // payloads queued about them, and an event written from the copy read
      // above would put back what that erasure removed.
      const [locked] = await tx.$queryRaw<Array<{ payload: Prisma.JsonValue }>>`
        SELECT "payload" FROM "billing_event_outbox"
         WHERE "id" = ${row.id} AND "processed_at" IS NULL
           FOR UPDATE`;
      if (locked === undefined) return 0;
      const parsed = BillingEventSchema.safeParse(locked.payload);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const attempts = row.attempts + 1;
        await tx.billingEventOutbox.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'does not match its schema'}`.slice(0, LAST_ERROR_MAX),
            nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
          },
        });
        log?.warn(
          { outboxId: row.id, applicationId: row.applicationId, attempts, issue },
          'billing log: queued event does not match this build\'s schema; kept for retry',
        );
        return 0;
      }
      // The writer's own key, else the provider event it describes, else this
      // outbox row: so a drain that runs twice writes once, and one provider
      // event queued twice writes once.
      const event = { ...parsed.data, dedupeKey: toBillingEventRow(parsed.data, `outbox:${row.id}`).dedupeKey };
      const stored = toBillingEventRow(event);
      if (await admitDiagnosticEvent(stored)) {
        await tx.billingEvent.createMany({ data: [stored], skipDuplicates: true });
      }
      await tx.billingEventOutbox.update({
        where: { id: row.id },
        // The event is in the log now. The copy here would only be a second
        // place to erase personal data from.
        data: { processedAt: new Date(), payload: Prisma.DbNull, lastError: null },
      });
      return 1;
    });
  }

  await pruneProcessedOutbox(now);
  return settled;
}

/**
 * What the poller runs on each tick: one indexed existence check, and a drain
 * only when a row is due or old enough to prune. The outbox is empty nearly
 * always, and every API process polls it.
 *
 * @example
 * setInterval(() => void pollBillingEventOutbox(app.log), 60_000);
 */
export async function pollBillingEventOutbox(log?: BillingLogLogger, now: Date = new Date()): Promise<number> {
  const prunableBefore = new Date(now.getTime() - PROCESSED_RETENTION_MS);
  const [work] = await prisma.$queryRaw<Array<{ pending: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "billing_event_outbox" WHERE "processed_at" IS NULL AND "next_attempt_at" <= ${now})
        OR EXISTS (SELECT 1 FROM "billing_event_outbox" WHERE "processed_at" < ${prunableBefore}) AS "pending"`;
  return work?.pending === true ? drainBillingEventOutbox(DEFAULT_BATCH, log) : 0;
}

/**
 * Delete rows processed more than the retention period ago, a bounded batch
 * at a time. An unprocessed row is never deleted, however old.
 *
 * @example
 * const removed = await pruneProcessedOutbox();
 */
export async function pruneProcessedOutbox(now: Date = new Date()): Promise<number> {
  const old = await prisma.billingEventOutbox.findMany({
    where: { processedAt: { lt: new Date(now.getTime() - PROCESSED_RETENTION_MS) } },
    select: { id: true },
    orderBy: { processedAt: 'asc' },
    take: PRUNE_BATCH,
  });
  if (old.length === 0) return 0;
  const { count } = await prisma.billingEventOutbox.deleteMany({
    where: { id: { in: old.map((row) => row.id) }, processedAt: { not: null } },
  });
  return count;
}
