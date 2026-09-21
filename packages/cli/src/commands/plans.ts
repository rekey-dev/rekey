/**
 * `rekey plans …`, Plan management.
 *
 *   rekey plans list --app <id> [--include-inactive]
 *   rekey plans create --app <id> --slug <slug> --name <name> --amount <int>
 *                        [--currency USD] [--interval MONTH|YEAR]
 *   rekey plans set-active --app <id> --slug <slug> --active true|false
 *
 * Money is the smallest currency unit (cents), never floats. The CLI refuses
 * fractional `--amount` values to prevent silent rounding bugs.
 *
 * `create` posts to the super-admin route, which builds SUBSCRIPTION plans and
 * nothing else. This command used to carry LICENSE / USAGE / CREDIT flags and
 * claim the API validated the per-kind combinations for us. It never did: that
 * route's body schema has no such fields, so it discarded them and answered
 * 201 for a SUBSCRIPTION plan. `--kind LICENSE --credits-amount 500` reported
 * success and created the wrong plan. The flags are refused here now, and the
 * route rejects an unknown key rather than dropping it.
 *
 * Per-kind plans are created from the panel, or from
 * POST /api/v1/tenant/applications/:id/plans, which implements every kind.
 */

import { Option, type Command } from 'commander';
import type { Paged } from '@rekey.dev/node';
import { ok, fail, readGlobalOpts } from '../lib/output.js';
import { adminRequest, listQuery, readListOpts, withListOptions } from '../lib/api.js';

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

  withListOptions(
    plans
      .command('list')
      .description('List Plans for an Application')
      .requiredOption('--app <id>', 'Application id')
      .option('--include-inactive', 'Include deactivated plans', false),
  )
    .action(async function (
      this: Command,
      opts: { app: string; includeInactive: boolean; limit?: string; offset?: string },
    ) {
      const ctx = readGlobalOpts(this);
      const qs = listQuery({
        ...(opts.includeInactive ? { includeInactive: 'true' } : {}),
        ...readListOpts(opts),
      });
      const path = `/api/v1/admin/applications/${encodeURIComponent(opts.app)}/plans${qs}`;
      // `{items, page}` since 2.0.0-rc.3, see `apps list` for why the page is
      // printed rather than silently dropped.
      const data = await adminRequest<Paged<PlanDto>>({ ctx, method: 'GET', path });
      ok(ctx, { plans: data.items, page: data.page }, (d) => {
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
        if (d.page.hasMore) {
          process.stdout.write(
            `\nShowing ${d.plans.length} of ${d.page.total}. Pass --offset ${
              d.page.offset + d.page.limit
            } for the next page.\n`,
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
    // Hidden, not deleted. `--help` must not advertise a flag this route
    // cannot honour, but a script or agent written against the old contract
    // deserves the explanation below rather than commander's bare "unknown
    // option". Every one of these is refused in the action.
    .addOption(
      new Option('--kind <kind>', 'SUBSCRIPTION only on this route').default('SUBSCRIPTION').hideHelp(),
    )
    .addOption(new Option('--license-kind <kind>', 'Not supported here').hideHelp())
    .addOption(new Option('--license-duration-days <int>', 'Not supported here').hideHelp())
    .addOption(new Option('--license-seats-allowed <int>', 'Not supported here').hideHelp())
    .addOption(new Option('--meter-slug <slug>', 'Not supported here').hideHelp())
    .addOption(new Option('--price-per-unit-cents <int>', 'Not supported here').hideHelp())
    .addOption(new Option('--credits-amount <int>', 'Not supported here').hideHelp())
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
      // The per-kind flags are refused BEFORE the request, not after it. The
      // super-admin route implements SUBSCRIPTION only; it used to validate
      // these fields away and answer 201, so the CLI reported success for a
      // plan of the wrong kind. Fail here, and name the surface that does
      // implement them, rather than letting the operator find out from a
      // pricing page that sells the wrong thing.
      const unsupported: string[] = [];
      if (opts.kind !== 'SUBSCRIPTION') unsupported.push(`--kind ${opts.kind}`);
      for (const [value, flag] of [
        [opts.licenseKind, '--license-kind'],
        [opts.licenseDurationDays, '--license-duration-days'],
        [opts.licenseSeatsAllowed, '--license-seats-allowed'],
        [opts.meterSlug, '--meter-slug'],
        [opts.pricePerUnitCents, '--price-per-unit-cents'],
        [opts.creditsAmount, '--credits-amount'],
      ] as const) {
        if (value !== undefined) unsupported.push(flag);
      }
      if (unsupported.length > 0) {
        fail(ctx, {
          code: 'CLI_PLANS_KIND_UNSUPPORTED',
          message:
            '`rekey plans create` builds SUBSCRIPTION plans only, so it cannot honour ' +
            `${unsupported.join(', ')}.`,
          fix:
            'Create LICENSE, USAGE and CREDIT plans in the panel (Application to Plans), or with ' +
            'POST /api/v1/tenant/applications/:id/plans and an operator token, which implements ' +
            'every kind.',
        });
      }

      const data = await adminRequest<PlanDto>({
        ctx,
        method: 'POST',
        path: `/api/v1/admin/applications/${encodeURIComponent(opts.app)}/plans`,
        // Exactly the fields the admin route implements. It rejects an unknown
        // key now instead of dropping it, so sending `kind` (even the correct
        // SUBSCRIPTION) would be a 400 rather than a no-op.
        body: {
          slug: opts.slug,
          name: opts.name,
          amount: amountInt,
          currency: opts.currency,
          interval: opts.interval,
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
