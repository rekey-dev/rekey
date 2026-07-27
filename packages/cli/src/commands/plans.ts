/**
 * `rekey plans …` — Plan management.
 *
 *   rekey plans list --app <id> [--include-inactive]
 *   rekey plans create --app <id> --slug <slug> --name <name> --amount <int>
 *                        [--currency USD] [--interval MONTH|YEAR]
 *                        [--kind SUBSCRIPTION|LICENSE|USAGE|CREDIT]
 *                        [--license-kind PERPETUAL|TIMED|SEATS]
 *                        [--license-duration-days <int>] [--license-seats-allowed <int>]
 *                        [--meter-slug <slug>] [--price-per-unit-cents <int>]
 *                        [--credits-amount <int>]
 *   rekey plans set-active --app <id> --slug <slug> --active true|false
 *
 * Money is the smallest currency unit (cents) — never floats. The CLI
 * refuses fractional `--amount` / `--price-per-unit-cents` values to prevent
 * silent rounding bugs. Per-kind field requirements (LICENSE needs
 * --license-kind, TIMED needs a duration, USAGE needs a meter + per-unit
 * price, CREDIT needs --credits-amount) are validated server-side; the API
 * returns a typed RekeyError.
 */

import type { Command } from 'commander';
import { ok, fail, readGlobalOpts } from '../lib/output.js';
import { adminRequest } from '../lib/api.js';

interface PlanDto {
  id: string;
  applicationId: string;
  slug: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
  kind: string;
  licenseKind: string | null;
  licenseSeatsAllowed: number | null;
  licenseDurationDays: number | null;
  meterSlug: string | null;
  pricePerUnitCents: number | null;
  creditsAmount: number | null;
  active: boolean;
}

export function registerPlansCommand(program: Command): void {
  const plans = program.command('plans').description('Manage Plans');

  plans
    .command('list')
    .description('List Plans for an Application')
    .requiredOption('--app <id>', 'Application id')
    .option('--include-inactive', 'Include deactivated plans', false)
    .action(async function (this: Command, opts: { app: string; includeInactive: boolean }) {
      const ctx = readGlobalOpts(this);
      const path = `/api/v1/admin/applications/${encodeURIComponent(opts.app)}/plans${
        opts.includeInactive ? '?includeInactive=true' : ''
      }`;
      const data = await adminRequest<PlanDto[]>({ ctx, method: 'GET', path });
      ok(ctx, { plans: data }, (d) => {
        if (d.plans.length === 0) {
          process.stdout.write('(no plans)\n');
          return;
        }
        for (const p of d.plans) {
          const flag = p.active ? '  ' : ' [inactive] ';
          process.stdout.write(
            `${p.slug.padEnd(20)} ${String(p.amount).padStart(8)} ${p.currency}/${p.interval}${flag}${p.name}\n`,
          );
        }
      });
    });

  plans
    .command('create')
    .description('Create a Plan')
    .requiredOption('--app <id>', 'Application id')
    .requiredOption('--slug <slug>')
    .requiredOption('--name <name>')
    .requiredOption('--amount <int>', 'Smallest currency unit, e.g. cents')
    .option('--currency <code>', 'ISO 4217 — defaults to USD', 'USD')
    .option('--interval <interval>', 'MONTH | YEAR', 'MONTH')
    .option('--kind <kind>', 'SUBSCRIPTION | LICENSE | USAGE | CREDIT', 'SUBSCRIPTION')
    .option('--license-kind <kind>', 'PERPETUAL | TIMED | SEATS (LICENSE plans)')
    .option('--license-duration-days <int>', 'Key lifetime in days (TIMED licenses)')
    .option('--license-seats-allowed <int>', 'Concurrent activations (SEATS licenses)')
    .option('--meter-slug <slug>', 'Usage meter to bill against (USAGE plans)')
    .option('--price-per-unit-cents <int>', 'Per-unit price in cents (USAGE plans)')
    .option('--credits-amount <int>', 'Credits granted per purchase (CREDIT plans)')
    .action(async function (
      this: Command,
      opts: {
        app: string;
        slug: string;
        name: string;
        amount: string;
        currency: string;
        interval: string;
        kind: string;
        licenseKind?: string;
        licenseDurationDays?: string;
        licenseSeatsAllowed?: string;
        meterSlug?: string;
        pricePerUnitCents?: string;
        creditsAmount?: string;
      },
    ) {
      const ctx = readGlobalOpts(this);

      // Parse + range-check an optional integer flag. Returns undefined when
      // the flag was not passed; calls fail() (which exits) on a bad value.
      const intOpt = (
        raw: string | undefined,
        flag: string,
        code: string,
        min: number,
      ): number | undefined => {
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < min) {
          fail(ctx, {
            code,
            message: `${flag} must be an integer >= ${min}. Got "${raw}".`,
            fix: 'Pass a whole number. Floats are rejected to prevent silent rounding.',
          });
        }
        return n;
      };

      const amountInt = Number(opts.amount);
      if (!Number.isInteger(amountInt) || amountInt < 0) {
        fail(ctx, {
          code: 'CLI_PLANS_AMOUNT_INVALID',
          message: `--amount must be a non-negative integer (smallest currency unit). Got "${opts.amount}".`,
          fix: 'Pass an integer like 999 (= $9.99 in USD). Floats are rejected to prevent silent rounding.',
        });
      }
      if (!['MONTH', 'YEAR'].includes(opts.interval)) {
        fail(ctx, {
          code: 'CLI_PLANS_INTERVAL_INVALID',
          message: `--interval must be MONTH or YEAR. Got "${opts.interval}".`,
          fix: 'Use MONTH or YEAR.',
        });
      }
      if (!['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT'].includes(opts.kind)) {
        fail(ctx, {
          code: 'CLI_PLANS_KIND_INVALID',
          message: `--kind must be SUBSCRIPTION, LICENSE, USAGE, or CREDIT. Got "${opts.kind}".`,
          fix: 'Use SUBSCRIPTION, LICENSE, USAGE, or CREDIT.',
        });
      }
      if (opts.licenseKind !== undefined && !['PERPETUAL', 'TIMED', 'SEATS'].includes(opts.licenseKind)) {
        fail(ctx, {
          code: 'CLI_PLANS_LICENSE_KIND_INVALID',
          message: `--license-kind must be PERPETUAL, TIMED, or SEATS. Got "${opts.licenseKind}".`,
          fix: 'Use PERPETUAL, TIMED, or SEATS.',
        });
      }

      // Combination rules (e.g. LICENSE needs --license-kind, TIMED needs a
      // duration, USAGE needs a meter + per-unit price, CREDIT needs
      // --credits-amount) are enforced by the API; it returns a typed
      // RekeyError we surface as-is.
      const licenseDurationDays = intOpt(
        opts.licenseDurationDays,
        '--license-duration-days',
        'CLI_PLANS_LICENSE_DURATION_INVALID',
        1,
      );
      const licenseSeatsAllowed = intOpt(
        opts.licenseSeatsAllowed,
        '--license-seats-allowed',
        'CLI_PLANS_LICENSE_SEATS_INVALID',
        1,
      );
      const pricePerUnitCents = intOpt(
        opts.pricePerUnitCents,
        '--price-per-unit-cents',
        'CLI_PLANS_PRICE_PER_UNIT_INVALID',
        0,
      );
      const creditsAmount = intOpt(
        opts.creditsAmount,
        '--credits-amount',
        'CLI_PLANS_CREDITS_AMOUNT_INVALID',
        1,
      );

      const data = await adminRequest<PlanDto>({
        ctx,
        method: 'POST',
        path: `/api/v1/admin/applications/${encodeURIComponent(opts.app)}/plans`,
        body: {
          slug: opts.slug,
          name: opts.name,
          amount: amountInt,
          currency: opts.currency,
          interval: opts.interval,
          kind: opts.kind,
          ...(opts.licenseKind !== undefined && { licenseKind: opts.licenseKind }),
          ...(licenseDurationDays !== undefined && { licenseDurationDays }),
          ...(licenseSeatsAllowed !== undefined && { licenseSeatsAllowed }),
          ...(opts.meterSlug !== undefined && { meterSlug: opts.meterSlug }),
          ...(pricePerUnitCents !== undefined && { pricePerUnitCents }),
          ...(creditsAmount !== undefined && { creditsAmount }),
        },
      });
      ok(ctx, data, (d) => {
        let detail: string;
        if (d.kind === 'LICENSE') {
          detail = `${d.amount} ${d.currency} · ${d.licenseKind ?? '?'}`;
          if (d.licenseKind === 'TIMED') detail += ` (${d.licenseDurationDays}d)`;
          if (d.licenseKind === 'SEATS') detail += ` (${d.licenseSeatsAllowed} seats)`;
        } else if (d.kind === 'USAGE') {
          detail = `${d.pricePerUnitCents}¢/unit on ${d.meterSlug}`;
        } else if (d.kind === 'CREDIT') {
          detail = `${d.amount} ${d.currency} → ${d.creditsAmount} credits`;
        } else {
          detail = `${d.amount} ${d.currency}/${d.interval}`;
        }
        process.stdout.write(`✓ ${d.slug} [${d.kind}]  ${detail}\n`);
      });
    });

  plans
    .command('set-active')
    .description("Toggle a Plan's active flag")
    .requiredOption('--app <id>', 'Application id')
    .requiredOption('--slug <slug>')
    .requiredOption('--active <bool>', 'true | false')
    .action(async function (this: Command, opts: { app: string; slug: string; active: string }) {
      const ctx = readGlobalOpts(this);
      const active = opts.active === 'true';
      if (!['true', 'false'].includes(opts.active)) {
        fail(ctx, {
          code: 'CLI_PLANS_ACTIVE_INVALID',
          message: '--active must be "true" or "false".',
          fix: 'Pass --active true or --active false.',
        });
      }
      const data = await adminRequest<PlanDto>({
        ctx,
        method: 'PATCH',
        path: `/api/v1/admin/applications/${encodeURIComponent(opts.app)}/plans/${encodeURIComponent(opts.slug)}`,
        body: { active },
      });
      ok(ctx, data, (d) => {
        process.stdout.write(`✓ ${d.slug} → active=${d.active}\n`);
      });
    });
}
