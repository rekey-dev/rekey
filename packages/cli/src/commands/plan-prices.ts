/**
 * `rekey plans prices …`, the prices a plan sells at.
 *
 *   rekey plans prices list <plan> --app <id>
 *   rekey plans prices add <plan> <currency> <amount> --app <id> [--countries IN,NP]
 *   rekey plans prices update <plan> <currency> --app <id> [--amount <n>] [--countries IN,NP]
 *   rekey plans prices archive <plan> <currency> --app <id>
 *
 * `<plan>` is the plan's id or its slug. Every price is a row, the default one
 * included: `list` shows them all, and `add`, `update` and `archive` work on
 * the prices in other currencies. The default price is changed through the
 * plan itself, and the API refuses it here with `PLAN_PRICE_IS_DEFAULT`.
 *
 * `add` and `update` call the same route, which creates the price when the
 * plan has none in that currency and changes it otherwise.
 *
 * These call the operator routes, so they need REKEY_OPERATOR_TOKEN, not the
 * super-admin key the rest of `rekey plans` uses.
 */

import type { Command } from 'commander';
import { formatMoney, type Paged, type PlanDto, type PlanPriceDto, type SetPlanPriceRequest } from '@rekey.dev/node';
import { ok, fail, readGlobalOpts, type OutputContext } from '../lib/output.js';
import { MAX_LIST_LIMIT, operatorRequest } from '../lib/api.js';
import { MINOR_UNITS_HELP, appPath, readCountries, readCurrency, readMinorUnits } from '../lib/input.js';

const CURRENCY = { code: 'CLI_PLANS_CURRENCY_INVALID', what: '<currency>' };
const COUNTRIES = { code: 'CLI_PLANS_COUNTRIES_INVALID', what: '--countries' };
const COUNTRIES_HELP =
  'Comma list of ISO 3166-1 alpha-2 codes where the price applies. "" means wherever its currency is the local one';

function pricePath(app: string, plan: string, currency: string): string {
  return appPath(app, `/plans/${encodeURIComponent(plan)}/prices/${encodeURIComponent(currency)}`);
}

/**
 * Where a price applies, for the text output.
 *
 * @example
 * describePriceCountries({ currency: 'INR', countries: [], isDefault: false }); // 'where INR is local'
 */
export function describePriceCountries(price: Pick<PlanPriceDto, 'currency' | 'countries' | 'isDefault'>): string {
  if (price.isDefault) return 'default';
  return price.countries.length === 0 ? `where ${price.currency} is local` : price.countries.join(',');
}

/**
 * One price as a line of text: its money, where it applies, its id and where
 * it stands at the provider.
 *
 * @example
 * priceLine(price); // 'INR  ₹1,499.00  where INR is local  pp_2  REGISTERED'
 */
export function priceLine(price: PlanPriceDto): string {
  const registration =
    price.registration.error === null
      ? price.registration.status
      : `${price.registration.status}: ${price.registration.error}`;
  return [
    price.currency,
    formatMoney(price.amount, price.currency),
    describePriceCountries(price),
    price.id,
    registration,
  ].join('  ');
}

async function findPlan(ctx: OutputContext, app: string, plan: string): Promise<PlanDto> {
  for (let offset = 0; ; offset += MAX_LIST_LIMIT) {
    const page = await operatorRequest<Paged<PlanDto>>({
      ctx,
      method: 'GET',
      path: appPath(app, `/plans?limit=${MAX_LIST_LIMIT}&offset=${offset}`),
      scope: 'read',
    });
    const found = page.items.find((each) => each.id === plan || each.slug === plan);
    if (found !== undefined) return found;
    if (!page.page.hasMore) break;
  }
  fail(ctx, {
    code: 'CLI_PLANS_PLAN_NOT_FOUND',
    message: `No plan with the id or slug "${plan}" in application "${app}".`,
    fix: `Run \`rekey plans list --app ${app} --include-inactive\` for the plans it has.`,
  });
}

async function putPrice(
  ctx: OutputContext,
  target: { app: string; plan: string; currency: string },
  body: SetPlanPriceRequest,
): Promise<void> {
  const data = await operatorRequest<PlanPriceDto>({
    ctx,
    method: 'PUT',
    path: pricePath(target.app, target.plan, target.currency),
    body,
    scope: 'applications:write',
  });
  ok(ctx, data, (price) => {
    process.stdout.write(`✓ ${target.plan}  ${priceLine(price)}\n`);
  });
}

/**
 * Attach `prices list`, `add`, `update` and `archive` under `rekey plans`.
 *
 * @example
 * registerPlanPricesCommand(program.command('plans'));
 */
export function registerPlanPricesCommand(plans: Command): void {
  const prices = plans.command('prices').description('The prices a plan sells at (uses REKEY_OPERATOR_TOKEN)');

  prices
    .command('list')
    .description('List every price of a plan, the default one first')
    .argument('<plan>', 'Plan id or slug')
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, planArg: string, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const plan = await findPlan(ctx, opts.app, planArg);
      const data = {
        plan: { id: plan.id, slug: plan.slug, isFree: plan.isFree, defaultPriceId: plan.defaultPriceId },
        prices: plan.prices,
      };
      ok(ctx, data, (d) => {
        if (d.prices.length === 0) {
          process.stdout.write(d.plan.isFree ? `${d.plan.slug} is free: it has no prices\n` : `${d.plan.slug} has no flat price\n`);
          return;
        }
        for (const price of d.prices) process.stdout.write(`${priceLine(price)}\n`);
      });
    });

  prices
    .command('add')
    .description('Add a price in another currency')
    .argument('<plan>', 'Plan id or slug')
    .argument('<currency>', 'ISO 4217 code, e.g. INR')
    .argument('<amount>', `Integer, ${MINOR_UNITS_HELP}`)
    .requiredOption('--app <id>', 'Application id')
    .option('--countries <list>', `${COUNTRIES_HELP}, which is also what a new price gets without this flag`)
    .action(async function (
      this: Command,
      plan: string,
      currencyArg: string,
      amountArg: string,
      opts: { app: string; countries?: string },
    ) {
      const ctx = readGlobalOpts(this);
      const currency = readCurrency(ctx, currencyArg, CURRENCY);
      const amount = readMinorUnits(ctx, amountArg, currency, { code: 'CLI_PLANS_AMOUNT_INVALID', what: '<amount>' });
      const countries = opts.countries === undefined ? undefined : readCountries(ctx, opts.countries, COUNTRIES);
      await putPrice(ctx, { app: opts.app, plan, currency }, { amount, ...(countries !== undefined && { countries }) });
    });

  prices
    .command('update')
    .description(
      "Change a price's amount, its countries, or both. The amount can change only until a provider has registered the price",
    )
    .argument('<plan>', 'Plan id or slug')
    .argument('<currency>', 'ISO 4217 code, e.g. INR')
    .requiredOption('--app <id>', 'Application id')
    .option('--amount <n>', `Integer, ${MINOR_UNITS_HELP}`)
    .option('--countries <list>', `${COUNTRIES_HELP}. Left out, the countries stay as they are`)
    .action(async function (
      this: Command,
      plan: string,
      currencyArg: string,
      opts: { app: string; amount?: string; countries?: string },
    ) {
      const ctx = readGlobalOpts(this);
      const currency = readCurrency(ctx, currencyArg, CURRENCY);
      if (opts.amount === undefined && opts.countries === undefined) {
        fail(ctx, {
          code: 'CLI_PLANS_PRICE_NO_CHANGE',
          message: 'Nothing to change: neither --amount nor --countries was given.',
          fix: 'Pass --amount <n>, --countries <list>, or both.',
        });
      }
      const amount =
        opts.amount === undefined
          ? undefined
          : readMinorUnits(ctx, opts.amount, currency, { code: 'CLI_PLANS_AMOUNT_INVALID', what: '--amount' });
      const countries = opts.countries === undefined ? undefined : readCountries(ctx, opts.countries, COUNTRIES);
      await putPrice(
        ctx,
        { app: opts.app, plan, currency },
        { ...(amount !== undefined && { amount }), ...(countries !== undefined && { countries }) },
      );
    });

  prices
    .command('archive')
    .description(
      'Stop selling a plan in a currency. The price row is kept, archived, when a subscription, a payment or a credit grant names it, and deleted when nothing does',
    )
    .argument('<plan>', 'Plan id or slug')
    .argument('<currency>', 'ISO 4217 code, e.g. INR')
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, plan: string, currencyArg: string, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const currency = readCurrency(ctx, currencyArg, CURRENCY);
      await operatorRequest<{ deleted: boolean }>({
        ctx,
        method: 'DELETE',
        path: pricePath(opts.app, plan, currency),
        scope: 'applications:write',
      });
      ok(ctx, { plan, currency, sold: false }, (d) => {
        process.stdout.write(`✓ ${d.plan}  ${d.currency} price is no longer sold\n`);
      });
    });
}
