/**
 * `rekey billing …`, how one Application's money is routed and recorded.
 *
 *   rekey billing log …                                  (see `billing-log.ts`)
 *   rekey billing preview --app <id> --country IN [--plan <slug|id>] [--coupon CODE]
 *       [--country-source declared|vouched|hint] [--currency INR] [--provider name]
 *       [--end-user id] [--on-unavailable-currency fallback|refuse]
 *   rekey billing reporting-currency get --app <id>
 *   rekey billing reporting-currency set <CODE> --app <id>
 *   rekey billing unavailable-currency get --app <id>
 *   rekey billing reconciliation --app <id> [--from ISO] [--to ISO]
 *   rekey billing price-fallbacks --app <id> [--from ISO] [--to ISO]
 *
 * These call the operator routes, so they need REKEY_OPERATOR_TOKEN. Changing
 * the unavailable-currency default needs an operator session, so it is done in
 * the panel.
 */

import type { Command } from 'commander';
import {
  formatMoney,
  priceFallbackMessage,
  type PriceFallbackSummary,
  type ReconciliationReport,
  type BillingConfig,
  type ReportingCurrencyDto,
  type RoutingPreviewDto,
  type RoutingPreviewInput,
} from '@rekey.dev/node';
import { ok, fail, readGlobalOpts, type OutputContext } from '../lib/output.js';
import { operatorRequest } from '../lib/api.js';
import { appPath, queryString, readChoice, readCurrency, readInstant } from '../lib/input.js';
import { registerBillingLogCommand } from './billing-log.js';

const COUNTRY_SOURCES = ['declared', 'vouched', 'hint'] as const;
const ON_UNAVAILABLE = ['fallback', 'refuse'] as const;
const DATE = { code: 'CLI_BILLING_DATE_INVALID' };

function periodQuery(ctx: OutputContext, opts: { from?: string; to?: string }): string {
  return queryString({
    from: opts.from === undefined ? undefined : readInstant(ctx, opts.from, { ...DATE, what: '--from' }),
    to: opts.to === undefined ? undefined : readInstant(ctx, opts.to, { ...DATE, what: '--to' }),
  });
}

/** The rule a preview applied to a named currency nobody can charge, and whose rule it was. */
function unavailableRuleLine(preview: RoutingPreviewDto, sent: boolean): string {
  const does = preview.onUnavailableCurrency === 'refuse' ? 'refused' : 'charged the default price';
  return `a named currency that cannot be charged is ${does} (${sent ? '--on-unavailable-currency' : 'the Application default'})\n`;
}

function printPreview(preview: RoutingPreviewDto): void {
  if (preview.items.length === 0) process.stdout.write('(no plans to preview)\n');
  for (const item of preview.items) {
    process.stdout.write(`${item.plan.slug}: ${item.summary}\n`);
    if (item.priceFallback !== null) process.stdout.write(`    ${priceFallbackMessage(item.priceFallback)}\n`);
    if (item.refusal !== null) {
      process.stdout.write(`    refused: ${item.refusal.code}: ${item.refusal.message}\n`);
      if (item.refusal.fix !== null) process.stdout.write(`    fix: ${item.refusal.fix}\n`);
    }
    if (item.coupon?.discount) {
      const { currency, discountAmount, amountAfterDiscount } = item.coupon.discount;
      process.stdout.write(
        `    coupon ${item.coupon.code}: ${formatMoney(discountAmount, currency)} off, ${formatMoney(amountAfterDiscount, currency)} to pay\n`,
      );
    }
    if (item.coupon?.refusal) {
      process.stdout.write(`    coupon ${item.coupon.code} refused: ${item.coupon.refusal.code}: ${item.coupon.refusal.message}\n`);
    }
  }
}

function printReconciliation(report: ReconciliationReport): void {
  const { checked } = report;
  process.stdout.write(`${report.from} to ${report.to}\n`);
  process.stdout.write(
    `checked ${checked.payments} payments, ${checked.refunds} refunds, ${checked.subscriptions} subscriptions, ${checked.events} log entries\n`,
  );
  if (report.paymentsLoggedSince === null) {
    process.stdout.write('payments were not checked: the log holds no payment entry yet\n');
  }
  if (report.subscriptionsLoggedSince === null) {
    process.stdout.write('subscriptions were not checked: the log holds no subscription entry yet\n');
  }
  const kinds = Object.entries(report.counts).filter(([, count]) => count > 0);
  if (kinds.length === 0) {
    process.stdout.write('✓ the log and the records agree\n');
    return;
  }
  for (const [kind, count] of kinds) process.stdout.write(`✗ ${kind}: ${count}${report.truncated ? ' or more' : ''}\n`);
  for (const finding of report.findings) {
    const money =
      finding.amount !== null && finding.currency !== null ? formatMoney(finding.amount, finding.currency) : '-';
    const ids = [
      finding.paymentId === null ? null : `payment=${finding.paymentId}`,
      finding.subscriptionId === null ? null : `subscription=${finding.subscriptionId}`,
      finding.eventSeq === null ? null : `entry=${finding.eventSeq}`,
    ].filter((id) => id !== null);
    process.stdout.write(`    ${finding.at}  ${finding.kind}  ${money}  ${ids.join(' ')}\n`);
  }
}

function printPriceFallbacks(summary: PriceFallbackSummary): void {
  process.stdout.write(`${summary.from} to ${summary.to}\n`);
  if (summary.total === 0) {
    process.stdout.write('✓ no checkout fell back to a default price\n');
    return;
  }
  process.stdout.write(`${summary.total} checkouts charged the default price because their currency could not be charged\n`);
  for (const group of summary.groups) {
    process.stdout.write(
      `    ${String(group.count).padStart(5)}  ${group.planSlug ?? '(plan unknown)'}  ${group.requestedCurrency ?? '?'} -> ${
        group.chargedCurrency ?? '?'
      }  ${group.country ?? '(country unknown)'}  last ${group.lastOccurredAt}\n`,
    );
  }
}

/**
 * Attach `rekey billing`.
 *
 * @example
 * registerBillingCommand(program);
 */
export function registerBillingCommand(program: Command): void {
  const billing = program
    .command('billing')
    .description("An Application's billing log, routing preview and reporting currency (uses REKEY_OPERATOR_TOKEN)");
  registerBillingLogCommand(billing);

  billing
    .command('preview')
    .description('Which price and provider a buyer in a country would get, decided by the functions checkout runs. Opens no checkout')
    .requiredOption('--app <id>', 'Application id')
    .requiredOption('--country <code>', 'ISO 3166-1 alpha-2, e.g. IN')
    .option('--plan <slug|id>', 'One plan. Left out, every active plan is previewed')
    .option('--coupon <code>', 'A coupon code the checkout would carry')
    .option('--country-source <source>', 'How checkout would learn the country: declared | vouched | hint (default vouched)')
    .option('--currency <code>', 'A currency the server would name. Only with --country-source declared')
    .option('--provider <name>', 'A provider the checkout would name')
    .option('--end-user <id>', 'Preview for this end user, given what they already pay for')
    .option(
      '--on-unavailable-currency <mode>',
      'fallback | refuse, when the named currency cannot be charged. Left out, the Application default applies',
    )
    .action(async function (
      this: Command,
      opts: {
        app: string;
        country: string;
        plan?: string;
        coupon?: string;
        countrySource?: string;
        currency?: string;
        provider?: string;
        endUser?: string;
        onUnavailableCurrency?: string;
      },
    ) {
      const ctx = readGlobalOpts(this);
      const country = opts.country.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) {
        fail(ctx, {
          code: 'CLI_BILLING_COUNTRY_INVALID',
          message: `--country must be one two-letter ISO 3166-1 code. Got "${opts.country}".`,
          fix: 'Pass a code such as IN, DE or US.',
        });
      }
      const body: RoutingPreviewInput = {
        country,
        ...(opts.plan !== undefined && { plan: opts.plan }),
        ...(opts.countrySource !== undefined && {
          countrySource: readChoice(ctx, opts.countrySource, COUNTRY_SOURCES, {
            code: 'CLI_BILLING_COUNTRY_SOURCE_INVALID',
            what: '--country-source',
          }),
        }),
        ...(opts.endUser !== undefined && { endUserId: opts.endUser }),
        ...(opts.currency !== undefined && {
          currency: readCurrency(ctx, opts.currency, { code: 'CLI_BILLING_CURRENCY_INVALID', what: '--currency' }),
        }),
        ...(opts.onUnavailableCurrency !== undefined && {
          onUnavailableCurrency: readChoice(ctx, opts.onUnavailableCurrency, ON_UNAVAILABLE, {
            code: 'CLI_BILLING_ON_UNAVAILABLE_INVALID',
            what: '--on-unavailable-currency',
          }),
        }),
        ...(opts.provider !== undefined && { provider: opts.provider }),
        ...(opts.coupon !== undefined && { couponCode: opts.coupon }),
      };
      const data = await operatorRequest<RoutingPreviewDto>({
        ctx,
        method: 'POST',
        path: appPath(opts.app, '/billing/checkout/preview'),
        body,
        scope: 'read',
      });
      ok(ctx, data, (preview) => {
        if (body.currency !== undefined) process.stdout.write(unavailableRuleLine(preview, body.onUnavailableCurrency !== undefined));
        printPreview(preview);
      });
    });

  const reporting = billing
    .command('reporting-currency')
    .description('The currency the stats lead with. Nothing is converted into it');

  const printReporting = (d: ReportingCurrencyDto) => process.stdout.write(`${d.reportingCurrency}  ${d.name}\n`);

  reporting
    .command('get')
    .description('Print the reporting currency')
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const data = await operatorRequest<ReportingCurrencyDto>({
        ctx,
        method: 'GET',
        path: appPath(opts.app, '/billing/reporting-currency'),
        scope: 'read',
      });
      ok(ctx, data, printReporting);
    });

  reporting
    .command('set')
    .description('Set the reporting currency. Changes no price, subscription or payment')
    .argument('<code>', 'ISO 4217 code a plan can be priced in, e.g. EUR')
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, code: string, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const reportingCurrency = readCurrency(ctx, code, { code: 'CLI_BILLING_CURRENCY_INVALID', what: '<code>' });
      const data = await operatorRequest<ReportingCurrencyDto>({
        ctx,
        method: 'PUT',
        path: appPath(opts.app, '/billing/reporting-currency'),
        body: { reportingCurrency },
        scope: 'applications:write',
      });
      ok(ctx, data, (d) => process.stdout.write(`✓ reporting in ${d.reportingCurrency}  ${d.name}\n`));
    });

  const unavailable = billing
    .command('unavailable-currency')
    .description('What a checkout does when the server names a currency no provider can charge and the request does not say');

  const RULE_MEANS = {
    fallback: 'charges the default price of the plan',
    refuse: 'refuses the checkout with BILLING_NO_PROVIDER_FOR_CURRENCY',
  } as const;
  const ruleOf = (config: BillingConfig) => ({ onUnavailableCurrency: config.onUnavailableCurrency });

  unavailable
    .command('get')
    .description("Print the Application's default: fallback or refuse")
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const application = await operatorRequest<{ billingConfig: BillingConfig }>({
        ctx,
        method: 'GET',
        path: appPath(opts.app, ''),
        scope: 'read',
      });
      ok(ctx, ruleOf(application.billingConfig), (d) =>
        process.stdout.write(`${d.onUnavailableCurrency}  ${RULE_MEANS[d.onUnavailableCurrency]}\n`),
      );
    });

  billing
    .command('reconciliation')
    .description('Compare the billing log with payments, refunds and subscriptions. The last 7 days unless --from and --to say otherwise, at most 31')
    .requiredOption('--app <id>', 'Application id')
    .option('--from <instant>', 'ISO 8601, e.g. 2026-10-01')
    .option('--to <instant>', 'ISO 8601, e.g. 2026-10-08')
    .action(async function (this: Command, opts: { app: string; from?: string; to?: string }) {
      const ctx = readGlobalOpts(this);
      const data = await operatorRequest<ReconciliationReport>({
        ctx,
        method: 'GET',
        path: appPath(opts.app, `/billing/reconciliation${periodQuery(ctx, opts)}`),
        scope: 'read',
      });
      ok(ctx, data, printReconciliation);
    });

  billing
    .command('price-fallbacks')
    .description('Count the checkouts that charged a default price because the buyer\'s currency could not be charged. The last 7 days unless --from and --to say otherwise, at most 31')
    .requiredOption('--app <id>', 'Application id')
    .option('--from <instant>', 'ISO 8601, e.g. 2026-10-01')
    .option('--to <instant>', 'ISO 8601, e.g. 2026-10-08')
    .action(async function (this: Command, opts: { app: string; from?: string; to?: string }) {
      const ctx = readGlobalOpts(this);
      const data = await operatorRequest<PriceFallbackSummary>({
        ctx,
        method: 'GET',
        path: appPath(opts.app, `/billing/price-fallbacks${periodQuery(ctx, opts)}`),
        scope: 'read',
      });
      ok(ctx, data, printPriceFallbacks);
    });
}
