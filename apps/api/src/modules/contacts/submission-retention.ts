/**
 * Deletes submissions older than their list's `submissionRetentionDays`.
 * Runs on the prune sweep. A list with no retention keeps them.
 */

import { prisma } from '../../lib/prisma.js';

const BATCH = 1_000;
const MAX_BATCHES = 50;

/** The age test is in SQL against each list's own setting, so one statement covers every list. */
export async function pruneExpiredSubmissions(now: Date = new Date()): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const count = await prisma.$executeRaw`
      DELETE FROM "contact_submissions"
      WHERE "id" IN (
        SELECT s."id" FROM "contact_submissions" s
        JOIN "contact_lists" l ON l."id" = s."list_id"
        WHERE l."submission_retention_days" IS NOT NULL
          AND s."created_at" < ${now}::timestamp - make_interval(days => l."submission_retention_days")
        LIMIT ${BATCH}
      )`;
    total += count;
    if (count < BATCH) break;
  }
  return total;
}

/** Tombstones past their expiry (see erasure-tombstone.ts). */
export async function pruneExpiredTombstones(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.contactErasureTombstone.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
