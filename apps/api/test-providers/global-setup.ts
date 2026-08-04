/**
 * One-shot setup for the provider sandbox harness.
 *
 * Three jobs, in order:
 *
 *   1. Point the suite at its OWN database and apply migrations. Never
 *      `rekey_test`: the sandbox suite and the default suite truncate the same
 *      tables, and two vitest runs sharing one database eat each other's
 *      fixtures. The default is a separate `rekey_sandbox`.
 *   2. Sweep whatever a previous run left in the provider sandbox. Cleanup on
 *      exit cannot survive a crash or a Ctrl-C; a sweep on entry is what makes
 *      repeated runs idempotent.
 *   3. Print the banner — on the way in, which credentials were found, and on
 *      the way out, which suites skipped and why. A run where everything
 *      skipped must not be mistakable for a run where everything passed.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYPAL_CLIENT_ID_VAR,
  PAYPAL_CLIENT_SECRET_VAR,
  RAZORPAY_KEY_ID_VAR,
  RAZORPAY_KEY_SECRET_VAR,
  SKIP_LOG_VAR,
  STRIPE_KEY_VAR,
  // `support/env-vars.ts`, NOT `support/credentials.ts`: the latter imports
  // `describe` from vitest, and vitest's global setup runs in a context where
  // that fails the entire run with "Vitest failed to access its internal state".
} from './support/env-vars.js';
import { stripeClient, sweepStaleHarnessObjects } from './support/stripe-sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repoRoot = path.resolve(apiDir, '../..');
const schemaPath = path.join(repoRoot, 'prisma/schema.prisma');

/**
 * The sandbox suite's own database.
 *
 * `SANDBOX_DATABASE_URL` first so a contributor can point it anywhere;
 * `rekey_sandbox` on the standard dev Postgres otherwise. `TEST_DATABASE_URL`
 * is NOT consulted — inheriting the default suite's database is the mistake
 * this ordering exists to prevent.
 */
function resolveDbUrl(): string {
  return (
    process.env.SANDBOX_DATABASE_URL ??
    'postgresql://rekey:rekey@localhost:5432/rekey_sandbox?schema=public'
  );
}

function line(text = ''): void {
  // eslint-disable-next-line no-console
  console.log(text);
}

function banner(title: string, rows: string[]): void {
  const width = Math.max(title.length, ...rows.map((r) => r.length)) + 2;
  line();
  line(`┌${'─'.repeat(width)}┐`);
  line(`│ ${title.padEnd(width - 2)} │`);
  line(`├${'─'.repeat(width)}┤`);
  for (const row of rows) line(`│ ${row.padEnd(width - 2)} │`);
  line(`└${'─'.repeat(width)}┘`);
  line();
}

export default async function setup(): Promise<() => void> {
  const dbUrl = resolveDbUrl();

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = dbUrl;
  process.env.JWT_SECRET ??= 'sandbox'.repeat(5);
  process.env.SUPER_ADMIN_KEY ??= 'sandbox-admin'.repeat(3);
  process.env.PANEL_URL ??= 'https://panel.sandbox.invalid';
  process.env.PUBLIC_PORTAL_URL ??= 'https://portal.sandbox.invalid';
  process.env.PORT ??= '0';
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS ??= 'true';
  // Ephemeral and per-run, so a real `sk_test_` key is AES-encrypted at rest
  // even in a throwaway database. Without it `lib/secrets.ts` silently falls
  // back to `plain.<hex>` and the sandbox key sits readable in a Postgres
  // row — which is fine right up until someone runs this against a database
  // they keep, or dumps it into a bug report.
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('hex');

  // Where `describeSandbox` records its skips for the closing banner.
  const skipDir = mkdtempSync(path.join(os.tmpdir(), 'rekey-sandbox-'));
  const skipLog = path.join(skipDir, 'skips.jsonl');
  writeFileSync(skipLog, '');
  process.env[SKIP_LOG_VAR] = skipLog;

  const configured = (...vars: string[]): string =>
    vars.every((v) => (process.env[v] ?? '').trim().length > 0) ? 'configured' : 'ABSENT';

  banner('Rekey provider sandbox harness', [
    `database   ${dbUrl.replace(/:[^:@]+@/, ':***@')}`,
    `stripe     ${configured(STRIPE_KEY_VAR)}  (${STRIPE_KEY_VAR})`,
    `paypal     ${configured(PAYPAL_CLIENT_ID_VAR, PAYPAL_CLIENT_SECRET_VAR)}  (${PAYPAL_CLIENT_ID_VAR}, ${PAYPAL_CLIENT_SECRET_VAR})`,
    `razorpay   ${configured(RAZORPAY_KEY_ID_VAR, RAZORPAY_KEY_SECRET_VAR)}  (${RAZORPAY_KEY_ID_VAR}, ${RAZORPAY_KEY_SECRET_VAR})`,
    'These suites talk to REAL provider sandboxes. Nothing here is mocked.',
  ]);

  execSync(`pnpm exec prisma migrate deploy --schema "${schemaPath}"`, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const stripeKey = process.env[STRIPE_KEY_VAR]?.trim();
  if (stripeKey?.startsWith('sk_test_')) {
    try {
      const removed = await sweepStaleHarnessObjects(stripeClient(stripeKey));
      const summary = Object.entries(removed)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      line(`[sandbox] swept stale Stripe harness objects: ${summary || 'none'}`);
    } catch (e) {
      line(`[sandbox] stale-object sweep failed (continuing): ${(e as Error).message}`);
    }
  }

  return (): void => {
    let skips: Array<{ provider: string; title: string; reason: string }> = [];
    try {
      skips = readFileSync(skipLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      /* nothing recorded */
    }
    rmSync(skipDir, { recursive: true, force: true });
    if (skips.length === 0) return;
    banner(
      `${skips.length} sandbox suite(s) DID NOT RUN — this run proves nothing about them`,
      skips.flatMap((s) => [`· ${s.title}`, `    ${s.reason}`]),
    );
  };
}
