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

// Both branches below exit without `app.close()`, deliberately.
//
// The document is already produced; everything past this point is teardown of a
// process that is about to end anyway, and the OS reclaims the sockets. What
// the close bought instead was a race: BullMQ's own RedisConnection re-emits a
// late "Connection is closed." after `close()` has detached the listeners that
// would have handled it, which is an unhandled 'error' event and therefore a
// hard crash. Exit 1 from a run that had already done its job, measured at
// roughly one run in ten: often enough to redden CI at random, rare enough to
// look like nothing but flake.
//
// A long-running server still shuts down through the normal path; this is a
// build tool.
const out = process.argv[2];
if (out) {
  // Synchronous, so the bytes are on disk before the exit.
  writeFileSync(out, json);
  // stderr is asynchronous on a pipe for the same reason stdout is, so leave
  // from the write callback here too or the confirmation line can be lost in
  // CI. The document itself is already on disk: writeFileSync above is
  // synchronous, which is why this line is a nicety and not the artifact.
  process.stderr.write(`wrote ${out}\n`, () => process.exit(0));
}

// The stdout branch must NOT exit the same way. Node's stdout is asynchronous
// when it is a pipe and `process.exit` does not flush it, so piping this
// document anywhere delivered exactly one or two 64KB pipe buffers of the
// 1.4MB: 65,536 or 131,072 bytes, and invalid JSON either way. The write
// callback fires once the data has actually been handed over, which is the
// only safe moment to leave.
//
// The `openapi:dump` script always passes an output path, so this branch is
// only reached by invoking the script directly. That is also why the bug
// survived: measuring it through `pnpm openapi:dump | wc -c` shows a steady
// 225 bytes, which is pnpm's own banner and not this document at all.
process.stdout.write(json, () => process.exit(0));
