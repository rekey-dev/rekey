/**
 * `rekey plans …`, Plan management.
 *
 *   rekey plans list --app <id> [--include-inactive]
 *   rekey plans create --app <id> --slug <slug> --name <name> --amount <int>
 *                        [--currency USD] [--interval MONTH|YEAR]
 *   rekey plans set-active --app <id> --slug <slug> --active true|false
 *   rekey plans local-prices <slug> <inherit|trusted|off> --app <id>
 *   rekey plans prices list|add|update|archive …   (see `plan-prices.ts`)
 *
 * An amount is a whole number of minor units of its currency, never a float,
 * and is printed for a person with `formatMoney`.
 *
 * `create` posts to the super-admin route, which builds SUBSCRIPTION plans and
 * nothing else, and whose body is closed: an unknown key is refused. The
 * LICENSE, USAGE and CREDIT flags this command once carried were discarded by
 * that route while it answered 201, so they are refused here by name.
 *
 * Per-kind plans are created from the panel, or from
 * POST /api/v1/tenant/applications/:id/plans, which implements every kind.
 */

import { Option, type Command } from 'commander';
import { formatMoney, validatePriceAmount, type Paged, type PlanDto, type UpdatePlanRequest } from '@rekey.dev/node';
import { ok, fail, readGlobalOpts } from '../lib/output.js';
import { adminRequest, listQuery, operatorRequest, readListOpts, withListOptions } from '../lib/api.js';
import { MINOR_UNITS_HELP, appPath } from '../lib/input.js';
import { priceLine, registerPlanPricesCommand } from './plan-prices.js';

/**
 * What a plan charges, in a few words.
 *
 * @example
 * planHeadline(plan); // '$19.00/MONTH', 'free' or 'no flat price'
 */
export function planHeadline(plan: Pick<PlanDto, 'prices' | 'isFree' | 'interval'>): string {
  const defaultPrice = plan.prices.find((price) => price.isDefault);
  if (defaultPrice !== undefined) return `${formatMoney(defaultPrice.amount, defaultPrice.currency)}/${plan.interval}`;
  return plan.isFree ? 'free' : 'no flat price';
}

const LOCAL_PRICES_RULES = ['INHERIT', 'TRUSTED', 'OFF'] as const;

export function registerPlansCommand(program: Command): void {
  const plans = program.command('plans').description('Manage Plans');
  registerPlanPricesCommand(plans);

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
        ...readListOpts(ctx, opts),
      });
      const path = `/api/v1/admin/applications/${encodeURIComponent(opts.app)}/plans${qs}`;
      const data = await adminRequest<Paged<PlanDto>>({ ctx, method: 'GET', path });
      ok(ctx, { plans: data.items, page: data.page }, (d) => {
        if (d.plans.length === 0) {
          process.stdout.write('(no plans)\n');
          return;
        }
        for (const p of d.plans) {
          const flag = p.active ? '' : '  [inactive]';
          process.stdout.write(`${p.slug.padEnd(20)} ${planHeadline(p)}  ${p.name}${flag}\n`);
          for (const price of p.prices) process.stdout.write(`    ${priceLine(price)}\n`);
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
    .requiredOption('--amount <int>', `Integer, ${MINOR_UNITS_HELP}. 0 makes a free plan`)
    .option('--currency <code>', 'ISO 4217, defaults to USD', 'USD')
    .option('--interval <interval>', 'MONTH | YEAR', 'MONTH')
    // Hidden, not deleted: a script written against the old contract gets the
    // explanation in the action instead of commander's bare "unknown option".
    .addOption(
      new Option('--kind <kind>', 'SUBSCRIPTION only on this route').default('SUBSCRIPTION').hideHelp(),
    )
    .addOption(new Option('--license-kind <kind>', 'Not supported here').hideHelp())
    .addOption(new Option('--license-duration-days <int>', 'Not supported here').hideHelp())
    .addOption(new Option('--license-seats-allowed <int>', 'Not supported here').hideHelp())
    .addOption(new Option('--meter-slug <slug>', 'Not supported here').hideHelp())
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
        creditsAmount?: string;
      },
    ) {
      const ctx = readGlobalOpts(this);

      const amountInt = /^\d+$/.test(opts.amount.trim()) ? Number(opts.amount) : Number.NaN;
      if (!Number.isSafeInteger(amountInt)) {
        fail(ctx, {
          code: 'CLI_PLANS_AMOUNT_INVALID',
          message: `--amount must be a whole number of minor units of ${opts.currency}, 0 or more. Got "${opts.amount}".`,
          fix: 'Pass an integer such as 1900 for $19.00 or 5000 for ¥5,000. Decimals are refused so nothing is rounded.',
        });
      }
      const price = amountInt === 0 ? { ok: true as const } : validatePriceAmount(opts.currency, amountInt);
      if (!price.ok) {
        fail(ctx, {
          code: 'CLI_PLANS_AMOUNT_INVALID',
          message: `--amount: ${price.message}`,
          fix: 'Pass an amount the currency can be priced at, in a currency a price can be in (`--currency`).',
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
      const unsupported: string[] = [];
      if (opts.kind !== 'SUBSCRIPTION') unsupported.push(`--kind ${opts.kind}`);
      for (const [value, flag] of [
        [opts.licenseKind, '--license-kind'],
        [opts.licenseDurationDays, '--license-duration-days'],
        [opts.licenseSeatsAllowed, '--license-seats-allowed'],
        [opts.meterSlug, '--meter-slug'],
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
        // The route's body is closed: `kind`, even the correct SUBSCRIPTION, is a 400.
        body: {
          slug: opts.slug,
          name: opts.name,
          // A plan with no price is free: the route takes no amount of zero.
          ...(amountInt > 0 && { price: { currency: opts.currency.toUpperCase(), amount: amountInt } }),
          interval: opts.interval,
        },
      });
      ok(ctx, data, (d) => {
        process.stdout.write(`✓ ${d.slug} [${d.kind}]  ${planHeadline(d)}\n`);
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

  plans
    .command('local-prices')
    .description(
      "Set whether a buyer's country may select one of a plan's prices in another currency. " +
        'inherit: follow the Application setting. trusted: only a country your server declared or a trusted proxy vouched for. ' +
        'off: every buyer is charged the default price unless your server names a currency. Needs REKEY_OPERATOR_TOKEN',
    )
    .argument('<slug>', 'Plan slug')
    .argument('<rule>', 'inherit | trusted | off')
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, slug: string, ruleArg: string, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const rule = LOCAL_PRICES_RULES.find((each) => each === ruleArg.trim().toUpperCase());
      if (rule === undefined) {
        fail(ctx, {
          code: 'CLI_PLANS_LOCAL_PRICES_INVALID',
          message: `<rule> must be inherit, trusted or off. Got "${ruleArg}".`,
          fix: 'Pass inherit to follow the Application setting, trusted for a verified country only, or off to charge every buyer the default price.',
        });
      }
      const body: UpdatePlanRequest = { localPrices: rule };
      const data = await operatorRequest<PlanDto>({
        ctx,
        method: 'PATCH',
        path: appPath(opts.app, `/plans/${encodeURIComponent(slug)}`),
        body,
        scope: 'applications:write',
      });
      ok(ctx, data, (d) => {
        process.stdout.write(`✓ ${d.slug}  local prices: ${d.localPrices.toLowerCase()}\n`);
      });
    });
}
