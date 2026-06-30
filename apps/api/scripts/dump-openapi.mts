/**
 * Dump the generated OpenAPI spec to stdout (or a file path arg).
 *
 * Builds the Fastify app to `.ready()` and reads `app.swagger()` — route
 * registration only attaches schemas, so no DB/Redis connection happens.
 * Feeds the marketing-site API reference (apps/marketing/public/openapi.json).
 *
 *   pnpm --filter @relipay/api openapi:dump        # -> marketing/public
 *   tsx scripts/dump-openapi.mts [outfile]
 *
 * Spec generation does no I/O, but the API's env loader validates required
 * vars at import time. Provide inert placeholders so this runs without a real
 * .env (CI, fresh clone). Real values are never needed — nothing connects.
 */
import { writeFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgresql://relipay:relipay@localhost:5432/relipay';
process.env.JWT_SECRET ??= '0'.repeat(48);
process.env.SUPER_ADMIN_KEY ??= '0'.repeat(48);
process.env.NODE_ENV ??= 'development';

// Dynamic import AFTER the env defaults above — a static import would evaluate
// the env loader before they're set.
const { buildApp } = await import('../src/app.js');

const app = await buildApp({ logger: false });
await app.ready();
const spec = app.swagger();
const json = JSON.stringify(spec, null, 2);

const out = process.argv[2];
if (out) {
  writeFileSync(out, json);
  console.error(`wrote ${out}`);
} else {
  process.stdout.write(json);
}
await app.close();
process.exit(0);
