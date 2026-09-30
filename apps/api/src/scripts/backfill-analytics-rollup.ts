/**
 * Fill the analytics rollup's past days from what is still stored. Run once
 * after deploying the rollup; safe to re-run and to stop half way: a day that
 * already has a row is never rewritten. See modules/analytics/rollup/backfill.ts
 * for what each day can hold.
 *
 *   docker compose exec api node apps/api/dist/scripts/backfill-analytics-rollup.js
 *   pnpm --filter @rekey.dev/api backfill:analytics-rollup      (from a checkout)
 */

import { pathToFileURL } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { backfillAll } from '../modules/analytics/rollup/backfill.js';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  backfillAll({ log: (line) => process.stdout.write(`${line}\n`) })
    .then(({ applications, days, failed }) => {
      process.stdout.write(`done: ${days} days written across ${applications} applications, ${failed} failed\n`);
      if (failed > 0) process.exitCode = 1;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
