/**
 * Backfill `EndUser.lastSignedInAt` / `lastSignInVia` from the newest stored
 * `user.signed_in` security event. Run once after deploying the sign-in
 * counters; safe to re-run and to stop half way.
 *
 * Not a migration statement, because one UPDATE joining every end user to the
 * security-event log holds row locks on the whole table for as long as the
 * scan takes. This walks users in id order, a batch per statement, and only
 * touches users with no `lastSignedInAt`, so a sign-in recorded since the
 * deploy is never overwritten and a second run finds nothing to do.
 *
 *   docker compose exec api node apps/api/dist/scripts/backfill-last-sign-in.js
 *   pnpm --filter @rekey.dev/api backfill:last-sign-in      (from a checkout)
 */

import { pathToFileURL } from 'node:url';
import { prisma } from '../lib/prisma.js';

export const BACKFILL_BATCH_SIZE = 5000;

/**
 * Backfill in batches of `batchSize` users. Returns how many rows changed and
 * how many batches it took.
 *
 * @example
 *   const { updated } = await backfillLastSignIn({ batchSize: 5000 });
 */
export async function backfillLastSignIn(
  options: { batchSize?: number; log?: (line: string) => void } = {},
): Promise<{ updated: number; batches: number }> {
  const batchSize = options.batchSize ?? BACKFILL_BATCH_SIZE;
  let cursor = '';
  let updated = 0;
  let batches = 0;
  for (;;) {
    const batch = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "end_users"
       WHERE "id" > ${cursor} AND "last_signed_in_at" IS NULL
       ORDER BY "id" LIMIT ${batchSize}`;
    if (batch.length === 0) break;
    batches += 1;
    const ids = batch.map((r) => r.id);
    updated += await prisma.$executeRaw`
      UPDATE "end_users" AS eu
         SET "last_signed_in_at" = latest."created_at",
             "last_sign_in_via" = latest."metadata"->>'via'
        FROM "end_users" AS b
        CROSS JOIN LATERAL (
          SELECT se."created_at", se."metadata" FROM "security_events" AS se
           WHERE se."application_id" = b."application_id"
             AND se."subject_end_user_id" = b."id"
             AND se."type" = 'user.signed_in'
           ORDER BY se."created_at" DESC
           LIMIT 1
        ) AS latest
       WHERE b."id" = ANY(${ids}) AND eu."id" = b."id" AND eu."last_signed_in_at" IS NULL`;
    cursor = ids[ids.length - 1]!;
    options.log?.(`batch ${batches}: ${ids.length} users scanned, ${updated} updated so far`);
  }
  return { updated, batches };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  backfillLastSignIn({ log: (line) => process.stdout.write(`${line}\n`) })
    .then(({ updated, batches }) => process.stdout.write(`done: ${updated} users updated in ${batches} batches\n`))
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
