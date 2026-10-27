/**
 * Operator MCP read tools for billing: what a buyer would be charged, how
 * often a price fell back, whether the log agrees with the records, one
 * payment and its refunds, the reporting currency and the stats per currency,
 * licenses, subscription import runs, unapplied payments and dunning cases.
 *
 * Each calls the function its REST route calls and returns what that route
 * returns, behind `billing:read` in TOOL_SCOPES.
 */

import { z } from 'zod';
import { RoutingPreviewRequestSchema } from '@rekey.dev/shared-types';
import { priceFallbackSummary, reconcileApplication, reconciliationPeriod } from '../billing-log/index.js';
import { refundsService } from '../billing/refunds.service.js';
import { getTenantPayment } from '../billing/tenant-payments.js';
import { reportingCurrency, reportingCurrencyDto } from '../billing/reporting-currency.js';
import { previewRouting } from '../billing/routing-preview.js';
import { billingStatsService } from '../billing/stats.service.js';
import { listDunningCases } from '../billing/dunning-cases.js';
import { isApplyStale } from '../billing/import.service.js';
import { unappliedPaymentsService } from '../billing/unapplied-payments.service.js';
import { licensesService } from '../licenses/licenses.service.js';
import { prisma } from '../../lib/prisma.js';
import type { OperatorTool } from './operator-tools.js';
import { loadAppInTenant } from './operator-write-tools.js';
import { ApplicationIdArg, CurrencyArg, MINOR_UNITS, defineTool } from './tool-definition.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const PERIOD =
  'The period is the last 7 days unless `from` and `to` say otherwise, and at most 31 days.';

const PeriodArgs = z
  .object({
    applicationId: ApplicationIdArg,
    from: z.string().datetime().optional().describe('ISO 8601. Start of the period.'),
    to: z.string().datetime().optional().describe('ISO 8601. End of the period.'),
  })
  .strict();

const preview = RoutingPreviewRequestSchema.shape;
const RoutingPreviewArgs = z
  .object({
    applicationId: ApplicationIdArg,
    country: preview.country.describe("The buyer's country, ISO 3166-1 alpha-2, any case."),
    plan: preview.plan.describe("A plan's id or slug. Leave it out to preview every active plan, at most 100."),
    countrySource: preview.countrySource.describe(
      'How the checkout would learn the country: `vouched` (a trusted proxy, the default), `hint` (the ' +
        "browser's own word) or `declared` (the operator's server with the secret key).",
    ),
    endUserId: preview.endUserId.describe('Preview for this end user, given what they already pay for.'),
    currency: CurrencyArg.optional().describe('A currency the server would name. `declared` only.'),
    onUnavailableCurrency: preview.onUnavailableCurrency.describe(
      'What a checkout naming `currency` asks for when no provider can charge it: `fallback` (the default price) or `refuse`. ' +
        "Left out, the Application's `billingConfig.onUnavailableCurrency` applies, as at checkout, and the result's " +
        '`onUnavailableCurrency` says which rule was applied.',
    ),
    provider: preview.provider.describe('A provider the checkout would name.'),
    couponCode: preview.couponCode.describe('A coupon code the checkout would carry.'),
  })
  .strict();

const PageArgs = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(1_000_000).default(0),
};

function page<T>(items: T[], total: number, limit: number, offset: number) {
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export const operatorBillingReadTools: OperatorTool[] = [
  defineTool({
    name: 'preview_checkout_routing',
    description:
      'Which price and provider a buyer in a country would get, decided by the functions checkout runs. It opens ' +
      'no checkout, writes nothing and calls no provider. One item per plan: `price` is the price charged ' +
      `(\`{ id, currency, amount, formatted, isDefault, reason }\`, \`amount\` an ${MINOR_UNITS}), ` +
      '`priceFallback` says when the default price is charged because the currency selected for the buyer cannot ' +
      'be, `provider` is who would charge it and `providerReason` why, and `refusal` carries the error checkout would answer ' +
      'with. With `couponCode` each item carries `coupon`: the `discount` it takes off (`discountAmount` and ' +
      '`amountAfterDiscount`, in the same minor units) or the `refusal` a checkout carrying it would answer with, ' +
      'such as COUPON_CURRENCY_NOT_COVERED. `summary` is the answer in one sentence.',
    args: RoutingPreviewArgs,
    annotations: READ_ONLY,
    run: async (ctx, { applicationId, ...request }) => {
      const app = await loadAppInTenant(ctx, applicationId, 'read');
      return previewRouting(app, request);
    },
  }),
  defineTool({
    name: 'list_price_fallbacks',
    description:
      "How often a buyer was charged a plan's default price because no enabled provider could charge the price " +
      'selected for them, grouped by plan, the currency asked for, the currency charged and the buyer\'s country, ' +
      `most frequent first. Counts, no amounts. ${PERIOD} To stop a group recurring, add its \`requestedCurrency\` ` +
      'to a provider that can charge it (configure_billing_provider).',
    args: PeriodArgs,
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      return priceFallbackSummary(app.id, reconciliationPeriod({ from: input.from, to: input.to }));
    },
  }),
  defineTool({
    name: 'get_billing_reconciliation',
    description:
      "Compare an application's billing log with its payments, refunds and subscriptions for one period: a " +
      'payment with no log entry, a log entry naming a payment that does not exist, a payment whose refunds add ' +
      'up differently in the payment, the refund records and the log, and a subscription with no activation ' +
      `entry. Reads only. ${PERIOD} It compares Rekey's own records with each other, not with the provider's ` +
      `list of charges. Any amount in a finding is an ${MINOR_UNITS}.`,
    args: PeriodArgs,
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      return reconcileApplication(app.id, reconciliationPeriod({ from: input.from, to: input.to }));
    },
  }),
  defineTool({
    name: 'get_payment',
    description:
      `One payment by id: \`amount\` and \`refundedAmount\` (each an ${MINOR_UNITS}), \`currency\`, \`status\`, ` +
      '`verification`, the `provider` that took it, and the paying end user. `refundable` says whether create_refund ' +
      'would reach that provider, and `refundBlockedReason` why not: `payment_not_succeeded`, `no_provider_charge_id`, ' +
      '`already_refunded`, `provider_unknown`, `provider_cannot_refund` or `provider_not_configured`. It is the ' +
      'judgement create_refund makes before it asks a provider, so read it before promising a refund. Payment ids ' +
      'come from recent_payments.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        paymentId: z.string().min(1).max(200).describe('The payment id, from recent_payments.'),
      })
      .strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      return getTenantPayment(app.id, input.paymentId);
    },
  }),
  defineTool({
    name: 'list_payment_refunds',
    description:
      'Every refund recorded against one payment, oldest first: those a provider reported and those issued ' +
      `through Rekey. Each has \`amount\` (${MINOR_UNITS}), \`currency\` (the payment's), \`status\` (pending, ` +
      "succeeded or failed), `reason` and `initiatedBy`. The payment's `refundedAmount` is the sum of the ones " +
      'that have not failed. Payment ids come from recent_payments.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        paymentId: z.string().min(1).max(200).describe('The payment id, from recent_payments.'),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      const { items, page } = await refundsService.listForPayment(app.id, input.paymentId, {
        limit: input.limit,
        offset: input.offset,
      });
      return { refunds: items, page };
    },
  }),
  defineTool({
    name: 'get_reporting_currency',
    description:
      'The currency an application reports in: the first entry of every per-currency list in get_billing_stats, ' +
      'the currency offered first for a new price or coupon, and the currency of a plan with no flat price. ' +
      'Nothing is converted into it. USD until set (set_reporting_currency).',
    args: z.object({ applicationId: ApplicationIdArg }).strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      return reportingCurrencyDto(reportingCurrency(app));
    },
  }),
  defineTool({
    name: 'get_billing_stats',
    description:
      "An application's billing figures, one entry per currency in every list, the reporting currency first. " +
      'Money in different currencies is never added together and there is no converted total. `mrr` is ' +
      '`{ currency, mrrCents, activeSubscriptions }`; `revenueLast30d` is verified payments as ' +
      '`{ currency, grossCents, refundedCents, netCents, payments }`; `unverified` is money in charges recorded ' +
      'and not applied, still held, of any age, as `{ currency, amountCents, payments }`, and is never inside ' +
      'revenue or MRR; `monthlyRevenue` is twelve months per currency. Every field ending in `Cents` is an ' +
      `${MINOR_UNITS}, whatever the currency. \`paymentsLast30d\` counts every payment recorded, verified or not. ` +
      '`unpricedLiveSubscriptions` counts live subscriptions on a plan with a flat price that record no price of their own: ' +
      'zero on a healthy application, not counted in MRR, and granting the plan again prices one.',
    args: z.object({ applicationId: ApplicationIdArg }).strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      return billingStatsService.cached(app.id);
    },
  }),
  defineTool({
    name: 'list_licenses',
    description:
      "An application's licenses, newest first: holder, plan, kind, status, `keyPrefix`, expiry and seats. " +
      'The license key itself is never returned.',
    args: z.object({ applicationId: ApplicationIdArg, ...PageArgs }).strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      const [items, total] = await Promise.all([
        licensesService.listForApplication(app.id, { take: input.limit, skip: input.offset }),
        licensesService.countForApplication(app.id),
      ]);
      return page(items, total, input.limit, input.offset);
    },
  }),
  defineTool({
    name: 'list_subscription_imports',
    description:
      "An application's subscription import runs, newest first: provider, mode (dry_run or applied), status, " +
      'match strategy, `counts` per outcome and `error`. `stale` is an `applying` run with no heartbeat for ' +
      'five minutes, which applying again resumes. Starting or applying an import stays in the panel and REST.',
    args: z.object({ applicationId: ApplicationIdArg, ...PageArgs }).strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      const where = { applicationId: app.id };
      const [runs, total] = await Promise.all([
        prisma.subscriptionImportRun.findMany({ where, take: input.limit, skip: input.offset, orderBy: { createdAt: 'desc' } }),
        prisma.subscriptionImportRun.count({ where }),
      ]);
      const now = new Date();
      const items = runs.map(({ applyLease: _lease, ...run }) => ({ ...run, stale: isApplyStale(run, now) }));
      return page(items, total, input.limit, input.offset);
    },
  }),
  defineTool({
    name: 'list_unapplied_payments',
    description:
      'Money a provider took that Rekey never applied (a succeeded payment with no subscription, usually a ' +
      'checkout that completed after Rekey stopped waiting), OLDEST first because refund windows close. Each ' +
      `has \`amount\` and \`refundedAmount\` (each an ${MINOR_UNITS}), \`currency\`, \`status\`, the end user, ` +
      '`ageDays` and `refundable`. Resolving one stays in the panel and REST.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        status: z.enum(['OPEN', 'REFUNDED', 'ENTITLEMENT_GRANTED', 'DISMISSED']).optional(),
        ...PageArgs,
      })
      .strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      const { items, total } = await unappliedPaymentsService.list(app.id, {
        ...(input.status && { status: input.status }),
        limit: input.limit,
        offset: input.offset,
      });
      return page(items, total, input.limit, input.offset);
    },
  }),
  defineTool({
    name: 'get_dunning_status',
    description:
      "An application's failed-payment recovery cases, newest first. A case opens when a subscription goes " +
      'PAST_DUE, sends reminders on day 0, 3 and 7 and is EXHAUSTED (subscription canceled) on day 14. Each has ' +
      'the subscription, end user, plan, `status`, `failedAttempts`, `remindersSent` and `nextActionAt`. ' +
      'Pass `subscriptionId` for one subscription.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        status: z.enum(['OPEN', 'RECOVERED', 'EXHAUSTED', 'CANCELED']).optional(),
        subscriptionId: z.string().min(1).max(200).optional().describe('Only cases on this subscription.'),
        ...PageArgs,
      })
      .strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      const { items, total } = await listDunningCases(app.id, {
        status: input.status,
        subscriptionId: input.subscriptionId,
        take: input.limit,
        skip: input.offset,
      });
      return page(items, total, input.limit, input.offset);
    },
  }),
];
