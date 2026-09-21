/**
 * Global test setup.
 *
 * Runs **once** per `vitest` invocation, before any test file. We use it for
 * environment defaults and to apply Prisma migrations against the test
 * database, applying migrations per-file would slow the suite down 10×.
 *
 * Test DB selection:
 *   1. `TEST_DATABASE_URL` env var
 *   2. `postgresql://rekey:rekey@localhost:5432/rekey_test?schema=public`
 *
 * In CI, the workflow exposes a fresh Postgres on localhost:5432, option 2
 * is the canonical default and "just works".
 *
 * `DATABASE_URL` is deliberately NOT consulted. It used to sit between the two,
 * and it points at a development database on any machine where it is exported.
 * This file runs `prisma migrate deploy` against whatever it resolves, and
 * `setup.ts` then issues `TRUNCATE ... RESTART IDENTITY CASCADE` between files,
 * so honouring it meant `pnpm test` could migrate and repeatedly empty the
 * developer's own database. Nothing warned, because from here the two URLs look
 * identical.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repoRoot = path.resolve(apiDir, '../..');
const schemaPath = path.join(repoRoot, 'prisma/schema.prisma');

const DEFAULT_TEST_DB_URL = 'postgresql://rekey:rekey@localhost:5432/rekey_test?schema=public';

function resolveTestDbUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DB_URL;
}

/**
 * Refuse anything that is not visibly a test database.
 *
 * The suite is destructive by design: it migrates the target and truncates every
 * table between files. The `_test` suffix is the one cheap, declarative signal
 * that the operator meant this database to be disposable, so require it rather
 * than trusting the URL to be pointed somewhere safe.
 */
function assertDisposable(url: string): void {
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`[test] TEST_DATABASE_URL is not a valid URL: ${redact(url)}`);
  }
  if (!name) {
    throw new Error(`[test] TEST_DATABASE_URL names no database: ${redact(url)}`);
  }
  if (!name.endsWith('_test')) {
    throw new Error(
      `[test] refusing to run against database "${name}": the suite applies migrations to it ` +
        'and TRUNCATEs every table between files, so it only runs against a database whose name ' +
        'ends in `_test`. Point TEST_DATABASE_URL at a disposable database (see CONTRIBUTING.md).',
    );
  }
}

function redact(url: string): string {
  return url.replace(/:[^:@]+@/, ':***@');
}

export default async function setup(): Promise<void> {
  const dbUrl = resolveTestDbUrl();
  assertDisposable(dbUrl);

  // Required-by-env-validator placeholders so `import { env } from './config/env'`
  // succeeds in test files. Real values are not used here, handlers read them
  // from `process.env` lazily where it matters.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = dbUrl;
  process.env.JWT_SECRET ??= 'test'.repeat(8);
  process.env.SUPER_ADMIN_KEY ??= 'admin'.repeat(7);
  // PANEL_URL and PUBLIC_PORTAL_URL have no defaults in env.ts, a Rekey
  // default would point a self-hoster's operators and end users at our
  // infrastructure. The suite exercises the flows that build those links
  // (operator MCP consent, hosted-portal CORS), so it supplies its own.
  process.env.PANEL_URL ??= 'https://panel.test.invalid';
  process.env.PUBLIC_PORTAL_URL ??= 'https://portal.test.invalid';
  process.env.PORT ??= '0';
  // Webhook tests register a 127.0.0.1 listener, flip the SSRF guard's
  // private-target gate so they keep working. Production deployments
  // leave this `false`.
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS ??= 'true';

  console.log(`[test] applying migrations to ${redact(dbUrl)}`);

  try {
    execSync(`pnpm exec prisma migrate deploy --schema "${schemaPath}"`, {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (err) {
    // Port 5432 is the default for every Postgres on the machine, not just this
    // one, so the default URL can land on an unrelated project's server. Prisma
    // reports that as a credentials problem (P1000), which sends you off to fix
    // a password on a database that was never the right target.
    const usingDefault = !process.env.TEST_DATABASE_URL;
    throw new Error(
      `[test] could not apply migrations to ${redact(dbUrl)}.\n` +
        (usingDefault
          ? 'This is the built-in default. If another project is already using port 5432, ' +
            'this reached that server instead of Rekey\'s. Check with ' +
            '`docker ps --format \'{{.Names}}\\t{{.Ports}}\'` and set TEST_DATABASE_URL to the ' +
            'right host and port (see CONTRIBUTING.md).'
          : 'TEST_DATABASE_URL is set, so check that it points at a running Postgres.') +
        `\nOriginal error: ${err instanceof Error ? err.message : String(err)}`,
      // Interpolated above for the reader, attached here so the stack survives.
      { cause: err },
    );
  }
}
