/**
 * Retention of the billing log. `PERMANENT` events live as long as their
 * Application. `DIAGNOSTIC` events are deleted 90 days after they were
 * recorded.
 */

import { prisma } from '../../lib/prisma.js';

export const DIAGNOSTIC_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 1000;
const MAX_BATCHES_PER_RUN = 20;

/**
 * Delete diagnostic events past their retention, in bounded batches. Returns
 * how many were deleted. A permanent event is never matched, whatever its age.
 *
 * The log's trigger refuses a DELETE unless the transaction switches
 * maintenance on, so each batch is its own short transaction.
 *
 * @example
 * const removed = await pruneDiagnosticEvents();
 */
export async function pruneDiagnosticEvents(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - DIAGNOSTIC_RETENTION_DAYS * DAY_MS);
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const deleted = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rekey.billing_events_maintenance', 'on', true)`;
      return tx.$executeRaw`
        DELETE FROM "billing_events"
         WHERE "seq" IN (
           SELECT "seq" FROM "billing_events"
            WHERE "tier" = 'DIAGNOSTIC' AND "recorded_at" < ${before}
            ORDER BY "recorded_at"
            LIMIT ${PRUNE_BATCH})
           AND "tier" = 'DIAGNOSTIC'`;
    });
    removed += deleted;
    if (deleted < PRUNE_BATCH) break;
  }
  return removed;
}
