/**
 * `rekey doctor`, diagnose configuration, connectivity and money.
 *
 *   rekey doctor [--app <id>]
 *
 * Each check has a `name`, a `status` (`ok`, `warn`, `fail` or `skipped`), a
 * `message`, a concrete `fix` when it is not `ok`, and the `applicationId` it
 * is about when it is about one. The exit code is non-zero when any check is
 * `fail`. A `skipped` check did not run, usually for want of a credential: it
 * is not a pass, and it does not fail the run.
 *
 * The money checks read with the operator token (`billing:read`), one
 * Application at a time, and the billing outbox with the super-admin key.
 * See `doctor/money-checks.ts` for what each one looks for.
 */

import type { Command } from 'commander';
import { ok, readGlobalOpts, type OutputContext } from '../lib/output.js';
import type { Check, CheckStatus } from './doctor/check.js';
import { runMoneyChecks, skippedMoneyChecks } from './doctor/money.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Diagnose CLI configuration, reach the Rekey API, and check the money setup of every Application the operator token can see',
    )
    .option('--app <id>', 'Run the money checks on this Application only')
    .action(async function (this: Command, opts: { app?: string }) {
      const ctx = readGlobalOpts(this);
      const checks = await runDoctorChecks(ctx, opts.app);
      ok(ctx, { checks }, renderChecks);
      if (checks.some((c) => c.status === 'fail')) process.exit(1);
    });
}

async function healthCheck(apiUrl: string): Promise<Check> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/health`);
    if (res.ok) return { name: 'health', status: 'ok', message: 'API responded 200 to /health' };
    return {
      name: 'health',
      status: 'fail',
      message: `API returned HTTP ${res.status} to /health.`,
      fix: 'Check that the Rekey API is running at the configured URL.',
    };
  } catch (err) {
    return {
      name: 'health',
      status: 'fail',
      message: `Could not reach ${apiUrl}/health: ${(err as Error).message}`,
      fix: 'Check network reachability and that Rekey is running.',
    };
  }
}

async function runDoctorChecks(ctx: OutputContext, applicationId: string | undefined): Promise<Check[]> {
  const checks: Check[] = [];

  if (!ctx.apiUrl) {
    checks.push({
      name: 'api-url',
      status: 'fail',
      message: 'REKEY_URL is not set.',
      fix: 'Set REKEY_URL in your environment, or pass --api-url=https://your-rekey.example.',
    });
  } else {
    checks.push({ name: 'api-url', status: 'ok', message: `using ${ctx.apiUrl}` });
  }

  if (!ctx.adminKey) {
    checks.push({
      name: 'admin-key',
      status: 'warn',
      message: 'SUPER_ADMIN_KEY is not set, admin commands will fail.',
      fix: 'Set SUPER_ADMIN_KEY in your environment, or pass --admin-key=<hex>.',
    });
  } else {
    checks.push({ name: 'admin-key', status: 'ok', message: 'admin key present' });
  }

  if (!ctx.apiUrl) {
    return [...checks, ...skippedMoneyChecks('not checked: no API URL', 'Set REKEY_URL, then run `rekey doctor` again.')];
  }
  const health = await healthCheck(ctx.apiUrl);
  checks.push(health);
  if (health.status !== 'ok') {
    return [
      ...checks,
      ...skippedMoneyChecks('not checked: the API did not answer /health', 'Fix the health check, then run `rekey doctor` again.'),
    ];
  }
  const money = await runMoneyChecks({
    apiUrl: ctx.apiUrl,
    operatorToken: ctx.operatorToken,
    adminKey: ctx.adminKey,
    applicationId,
    now: new Date(),
  });
  return [...checks, ...money];
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skipped: '-' };

function renderChecks(d: { checks: Check[] }): void {
  for (const c of d.checks) {
    const subject = c.applicationId === undefined ? c.name : `${c.name} [${c.applicationId}]`;
    process.stdout.write(`${SYMBOL[c.status]} ${subject.padEnd(12)} ${c.message}\n`);
    if (c.fix) process.stdout.write(`  fix: ${c.fix}\n`);
  }
}
