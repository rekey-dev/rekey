/**
 * Global test setup.
 *
 * Runs **once** per `vitest` invocation, before any test file. We use it for
 * environment defaults and to apply Prisma migrations against the test
 * database — applying migrations per-file would slow the suite down 10×.
 *
 * Test DB selection (in priority order):
 *   1. `TEST_DATABASE_URL` env var
 *   2. `DATABASE_URL` env var
 *   3. `postgresql://rekey:rekey@localhost:5432/relipay_test?schema=public`
 *
 * In CI, the workflow exposes a fresh Postgres on localhost:5432 — option 3
 * is the canonical default and "just works".
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repoRoot = path.resolve(apiDir, '../..');
const schemaPath = path.join(repoRoot, 'prisma/schema.prisma');

function resolveTestDbUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://rekey:rekey@localhost:5432/relipay_test?schema=public'
  );
}

export default async function setup(): Promise<void> {
  const dbUrl = resolveTestDbUrl();

  // Required-by-env-validator placeholders so `import { env } from './config/env'`
  // succeeds in test files. Real values are not used here — handlers read them
  // from `process.env` lazily where it matters.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = dbUrl;
  process.env.JWT_SECRET ??= 'test'.repeat(8);
  process.env.SUPER_ADMIN_KEY ??= 'admin'.repeat(7);
  process.env.PORT ??= '0';
  // Webhook tests register a 127.0.0.1 listener — flip the SSRF guard's
  // private-target gate so they keep working. Production deployments
  // leave this `false`.
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS ??= 'true';

  // eslint-disable-next-line no-console
  console.log(`[test] applying migrations to ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);

  execSync(`pnpm exec prisma migrate deploy --schema "${schemaPath}"`, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
