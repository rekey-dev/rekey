/**
 * Dump the generated OpenAPI spec to stdout (or a file path arg).
 *
 * Builds the Fastify app to `.ready()` and reads `app.swagger()` — route
 * registration only attaches schemas, so it DOES need a reachable Postgres: buildApp() calls primeCorsOrigins(), which queries `application`. Point DATABASE_URL at any migrated database (a throwaway container is fine).
 * Writes the OpenAPI document to the path given as the first argument.
 *
 *   pnpm --filter @rekey.dev/api openapi:dump        # -> marketing/public
 *   tsx scripts/dump-openapi.mts [outfile]
 *
 * Spec generation does no I/O, but the API's env loader validates required
 * vars at import time. Provide inert placeholders so this runs without a real
 * .env (CI, fresh clone). Real values are never needed — nothing connects.
 */
import { writeFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgresql://rekey:rekey@localhost:5432/rekey';
process.env.JWT_SECRET ??= '0'.repeat(48);
process.env.SUPER_ADMIN_KEY ??= '0'.repeat(48);
process.env.NODE_ENV ??= 'development';

// `servers` is now `[{ url: env.API_URL }]` — a deployment's own `/docs` must
// advertise ITSELF, never our host (see lib/swagger.ts). That is right at
// runtime and wrong for THIS artifact: the file written here is the reference
// published at rekey.dev, read by integrators who are calling Rekey Cloud, and
// generating it on a laptop would otherwise publish `http://localhost:3030` as
// the server. So the published document — and only the published document —
// pins the Cloud origin. Override `API_URL` to regenerate it for somewhere else.
process.env.API_URL ??= 'https://api.rekey.dev';

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
