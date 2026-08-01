/**
 * `rekey doctor` — diagnose connectivity + config.
 *
 * Designed for AI agents to read structured output and self-heal. Each check
 * has a `name`, a `status` (`ok` / `warn` / `fail`), a human `message`, and
 * (when not OK) a concrete `fix`. Exit code is non-zero if any `fail` check
 * triggered.
 */

import type { Command } from 'commander';
import { ok, readGlobalOpts, type OutputContext } from '../lib/output.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose CLI configuration + reach the Rekey API')
    .action(async function (this: Command) {
      const ctx = readGlobalOpts(this);
      const checks = await runDoctorChecks(ctx);
      ok(ctx, { checks }, renderChecks);
      if (checks.some((c) => c.status === 'fail')) process.exit(1);
    });
}

async function runDoctorChecks(ctx: OutputContext): Promise<Check[]> {
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
      message: 'SUPER_ADMIN_KEY is not set — admin commands will fail.',
      fix: 'Set SUPER_ADMIN_KEY in your environment, or pass --admin-key=<hex>.',
    });
  } else {
    checks.push({ name: 'admin-key', status: 'ok', message: 'admin key present' });
  }

  if (ctx.apiUrl) {
    try {
      const res = await fetch(`${ctx.apiUrl.replace(/\/$/, '')}/health`);
      if (res.ok) {
        checks.push({ name: 'health', status: 'ok', message: 'API responded 200 to /health' });
      } else {
        checks.push({
          name: 'health',
          status: 'fail',
          message: `API returned HTTP ${res.status} to /health.`,
          fix: 'Check that the Rekey API is running at the configured URL.',
        });
      }
    } catch (err) {
      checks.push({
        name: 'health',
        status: 'fail',
        message: `Could not reach ${ctx.apiUrl}/health: ${(err as Error).message}`,
        fix: 'Check network reachability + that Rekey is running.',
      });
    }
  }

  return checks;
}

function renderChecks(d: { checks: Check[] }): void {
  for (const c of d.checks) {
    const symbol = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
    process.stdout.write(`${symbol} ${c.name.padEnd(12)} ${c.message}\n`);
    if (c.fix) process.stdout.write(`  fix: ${c.fix}\n`);
  }
}
