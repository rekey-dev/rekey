/**
 * Billing tools of one Application: the billing log, the routing preview,
 * prices, coupons, the reporting currency, payments and refunds.
 *
 * These call the operator routes (`/api/v1/tenant/applications/:id/…`), so
 * every one of them authenticates with the scoped operator token and none
 * with the super-admin key. Reads need the `billing:read` scope. The WRITE
 * tools need `billing:write`, and the server refuses them without it.
 */

import { z } from 'zod';
import type { AdminClient, OperatorNeed } from './client.js';
import { MINOR_UNITS, PagingArgs, defineTool, query, type ToolDefinition } from './tool-types.js';

const READ: OperatorNeed = { kind: 'read', scope: 'billing:read' };
const WRITE: OperatorNeed = { kind: 'write', scope: 'billing:write' };

const WRITE_NOTE =
  'Authenticates as a SCOPED operator via REKEY_OPERATOR_TOKEN (never the admin key); the token must carry the `billing:write` scope and belong to the workspace that owns the Application. ';

const applicationId = z.string().describe("Application id. Must belong to the operator token's workspace.");
const currencyCode = (what: string) => z.string().length(3).describe(`${what} ISO 4217 code, e.g. USD, INR or JPY.`);
const instant = (what: string) => z.string().describe(`${what} ISO 8601 with its zone, e.g. 2026-10-01T00:00:00Z.`);

const PeriodArgs = {
  from: instant('Start of the period.').optional(),
  to: instant('End of the period.').optional(),
};

const CouponAmounts = z
  .array(
    z.object({
      currency: currencyCode('The currency this amount is in:'),
      amountOff: z.number().int().positive().describe(`What the coupon takes off: ${MINOR_UNITS}. 500 is $5.00 in USD and ¥500 in JPY.`),
    }),
  )
  .max(200);

function app(id: string, rest: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(id)}${rest}`;
}

function read<T>(client: AdminClient, path: string): Promise<T> {
  return client.requestAsOperator<T>('GET', path, undefined, READ);
}

/** `args` without `applicationId` and the other path fields, and without the keys that were not sent. */
function bodyOf<T extends Record<string, unknown>>(args: T, pathKeys: ReadonlyArray<keyof T>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => !pathKeys.includes(key) && value !== undefined));
}

const RecentBillingEventsArgs = z.object({
  applicationId,
  type: z
    .array(z.string())
    .optional()
    .describe('Only these event types, e.g. ["checkout.price_fallback", "payment.refunded"]. The API refuses a type the log does not have.'),
  tier: z.enum(['PERMANENT', 'DIAGNOSTIC']).optional().describe('PERMANENT events are kept for the life of the Application; DIAGNOSTIC ones (opened and refused checkouts) 90 days.'),
  endUserId: z.string().optional().describe('Only entries about this end user.'),
  subscriptionId: z.string().optional().describe('Only entries that name this subscription.'),
  paymentId: z.string().optional().describe('Only entries that name this payment, its refunds included.'),
  currency: currencyCode('Only entries about money in this currency:').optional(),
  ...PeriodArgs,
  limit: z.number().int().min(1).max(200).optional().describe('Entries per page, 1-200. Default 50.'),
  cursor: z.string().optional().describe('The `nextCursor` of the previous page. Entries older than it are returned.'),
  include: z.array(z.enum(['actors'])).max(1).optional().describe('["actors"] also returns `actors`: the email of each end user the entries name and the name and email of each operator who acted, as they stand now. Nothing of it is stored in the log. End users are resolved only for a token with `end-users:read`.'),
});

const PreviewArgs = z.object({
  applicationId,
  country: z.string().length(2).describe("The buyer's country, ISO 3166-1 alpha-2, e.g. IN."),
  plan: z.string().optional().describe("A plan's id or slug. Left out, every active plan is previewed (at most 100)."),
  countrySource: z
    .enum(['declared', 'vouched', 'hint'])
    .optional()
    .describe("How checkout would learn the country: `vouched` by a trusted proxy (default), a browser's own `hint`, or `declared` by the operator's server with the secret key."),
  endUserId: z.string().optional().describe('Preview for this end user, given what they already pay for.'),
  currency: currencyCode('A currency the server would name (only with countrySource `declared`):').optional(),
  onUnavailableCurrency: z.enum(['fallback', 'refuse']).optional().describe("What a checkout naming `currency` asks for when no provider can charge it. Left out, the Application's `billingConfig.onUnavailableCurrency` applies, as at checkout, and the result's `onUnavailableCurrency` says which rule was applied."),
  provider: z.string().optional().describe('A provider the checkout would name.'),
  couponCode: z.string().optional().describe('A coupon code the checkout would carry. Each item then says what it takes off, or why it is refused.'),
});

const PeriodOfApplicationArgs = z.object({ applicationId, ...PeriodArgs });
const ApplicationArgs = z.object({ applicationId });

const GetPaymentArgs = z.object({
  applicationId,
  paymentId: z.string().describe('Payment id.'),
});

const ListRefundsArgs = z.object({
  applicationId,
  paymentId: z.string().describe('Payment id.'),
  ...PagingArgs,
});

const SetPlanPriceArgs = z.object({
  applicationId,
  plan: z.string().describe("The plan's id or slug."),
  currency: currencyCode("The price's currency:"),
  amount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`The price: ${MINOR_UNITS}. 1900 is $19.00 in USD, 5000 is ¥5,000 in JPY. Required to add a price; leave it out to change only \`countries\`.`),
  countries: z
    .array(z.string().length(2))
    .max(250)
    .optional()
    .describe('ISO 3166-1 alpha-2 codes where the price applies. Empty means wherever the currency is the local one. Left out on an update, the list stays as it is.'),
});

const ArchivePlanPriceArgs = z.object({
  applicationId,
  plan: z.string().describe("The plan's id or slug."),
  currency: currencyCode("The price's currency:"),
});

const CouponTerms = {
  basisPoints: z.number().int().min(1).max(10000).optional().describe('PERCENT coupons: hundredths of a percent, 1500 is 15%.'),
  amounts: CouponAmounts.optional().describe('AMOUNT coupons: one entry per currency the coupon works in. An amount is never converted to another currency.'),
  currencies: z.array(z.string().length(3)).max(200).optional().describe('PERCENT coupons: limit the coupon to prices in these ISO 4217 currencies. Empty means any currency.'),
  planSlugs: z.array(z.string()).optional().describe('Limit the coupon to these plans. Empty means any plan.'),
};

const CreateCouponArgs = z.object({
  applicationId,
  code: z.string().min(1).max(40).describe('The code a buyer enters. Stored lower-case.'),
  discountType: z.enum(['PERCENT', 'AMOUNT']).describe('PERCENT takes `basisPoints`; AMOUNT takes `amounts`.'),
  ...CouponTerms,
  startsAt: instant('When the coupon starts working.').optional(),
  endsAt: instant('When the coupon stops working.').optional(),
  maxRedemptions: z.number().int().min(1).optional().describe('Redemptions allowed in total, across every currency.'),
  maxRedemptionsPerUser: z.number().int().min(1).optional().describe('Redemptions allowed per end user.'),
});

const UpdateCouponArgs = z.object({
  applicationId,
  code: z.string().describe('The code of the coupon to change.'),
  active: z.boolean().optional().describe('false retires the coupon.'),
  ...CouponTerms,
  endsAt: instant('When the coupon stops working. null removes the end.').nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional().describe('Redemptions allowed in total, across every currency. null removes the cap. Refused below the redemptions already held.'),
  maxRedemptionsPerUser: z.number().int().min(1).nullable().optional().describe('Redemptions allowed per end user. null removes the cap. Refused when one end user already holds more.'),
});

const SetReportingCurrencyArgs = z.object({
  applicationId,
  reportingCurrency: currencyCode('A currency a plan can be priced in:'),
});

const CreateRefundArgs = z.object({
  applicationId,
  paymentId: z.string().describe('The payment to refund.'),
  amount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`How much to pay back: ${MINOR_UNITS}, in the payment's own currency. Left out, everything not yet refunded.`),
  reason: z.string().min(1).max(500).optional().describe('Kept on the refund, and sent to the provider where it takes one.'),
  idempotencyKey: z.string().min(1).max(200).optional().describe('What makes two calls one refund at the provider. Left out, the API derives it from the payment, what was refunded and the amount.'),
});

export const billingTools: Array<ToolDefinition<z.ZodRawShape>> = [
  defineTool({
    name: 'recent_billing_events',
    description:
      "Read an Application's billing log, newest first: checkouts opened, completed and refused, a price that fell back to the default because its currency could not be charged, payments recorded, failed, not applied and refunded, subscriptions, coupons, and changes to prices and billing settings. " +
      `Each entry carries \`type\`, \`occurredAt\`, the ids it names, and \`amount\` (${MINOR_UNITS}) with \`currency\` when it is about money. ` +
      'Returns `{items, nextCursor, actors}`: pass `nextCursor` back as `cursor` for older entries; null means the end. Entries name people by id; with `include: ["actors"]`, `actors` says who those ids are now (an erased end user has `state: "erased"` and no email), and it is null otherwise. Uses REKEY_OPERATOR_TOKEN (`billing:read`).',
    inputSchema: RecentBillingEventsArgs,
    execute: (c, args) =>
      read(
        c,
        app(
          args.applicationId,
          `/billing/events${query({
            type: args.type?.join(','),
            tier: args.tier,
            endUserId: args.endUserId,
            subscriptionId: args.subscriptionId,
            paymentId: args.paymentId,
            currency: args.currency?.toUpperCase(),
            from: args.from,
            to: args.to,
            limit: args.limit,
            cursor: args.cursor,
            include: args.include?.join(','),
          })}`,
        ),
      ),
  }),
  defineTool({
    name: 'preview_checkout_routing',
    description:
      'Answer, for a buyer in a country, which price and currency each plan would be charged at, which provider would charge it and why, with the functions checkout itself runs. Opens no checkout, writes nothing and calls no provider. ' +
      `Each item has \`price\` (\`amount\`: ${MINOR_UNITS}; \`formatted\` is the same amount written for a person), \`priceFallback\` when the buyer's currency cannot be charged and the default price is charged instead, \`refusal\` when checkout would refuse, and a one-sentence \`summary\`. ` +
      'With `couponCode`, each item also carries `coupon`: the `discount` it takes off, or the `refusal` a checkout carrying it would get (for example COUPON_CURRENCY_NOT_COVERED). Uses REKEY_OPERATOR_TOKEN (`billing:read`).',
    inputSchema: PreviewArgs,
    execute: (c, args) =>
      c.requestAsOperator('POST', app(args.applicationId, '/billing/checkout/preview'), bodyOf(args, ['applicationId']), READ),
  }),
  defineTool({
    name: 'get_price_fallbacks',
    description:
      "Count the checkouts that charged a plan's default price because no enabled provider could charge the price selected for the buyer, grouped by plan, the currency asked for, the currency charged and the buyer's country, most frequent first. " +
      'The last 7 days unless `from` and `to` say otherwise, at most 31. To stop a group recurring, add its `requestedCurrency` to a provider that can charge it. Uses REKEY_OPERATOR_TOKEN (`billing:read`).',
    inputSchema: PeriodOfApplicationArgs,
    execute: (c, args) => read(c, app(args.applicationId, `/billing/price-fallbacks${query({ from: args.from, to: args.to })}`)),
  }),
  defineTool({
    name: 'get_billing_reconciliation',
    description:
      "Compare an Application's billing log with its payments, refunds and subscriptions for one period: a payment with no log entry, a log entry naming a payment that does not exist, refunds that add up differently, a subscription with no activation entry. " +
      `\`counts\` is per kind and all zero when they agree; each finding's \`amount\` is ${MINOR_UNITS}. The last 7 days unless \`from\` and \`to\` say otherwise, at most 31. It compares Rekey's own records with each other, not with the provider's list of charges. Uses REKEY_OPERATOR_TOKEN (\`billing:read\`).`,
    inputSchema: PeriodOfApplicationArgs,
    execute: (c, args) => read(c, app(args.applicationId, `/billing/reconciliation${query({ from: args.from, to: args.to })}`)),
  }),
  defineTool({
    name: 'get_payment',
    description:
      `Read one payment by id: \`amount\` and \`refundedAmount\` (each ${MINOR_UNITS}), \`currency\`, \`status\`, \`verification\`, the \`provider\` that took it and the paying end user. ` +
      '`refundable` says whether create_refund would reach that provider, and `refundBlockedReason` why not (`payment_not_succeeded`, `no_provider_charge_id`, `already_refunded`, `provider_unknown`, `provider_cannot_refund` or `provider_not_configured`): the judgement the refund makes before it asks a provider. Read it before promising a refund. Uses REKEY_OPERATOR_TOKEN (`billing:read`).',
    inputSchema: GetPaymentArgs,
    execute: (c, args) => read(c, app(args.applicationId, `/payments/${encodeURIComponent(args.paymentId)}`)),
  }),
  defineTool({
    name: 'list_refunds',
    description:
      'List every refund recorded against one payment, oldest first: those a provider reported and those issued through Rekey. ' +
      `Each refund's \`amount\` is ${MINOR_UNITS}, in the payment's currency. A \`failed\` refund counts for nothing. Returns \`{items, page}\`. Uses REKEY_OPERATOR_TOKEN (\`billing:read\`).`,
    inputSchema: ListRefundsArgs,
    execute: (c, args) =>
      read(
        c,
        app(args.applicationId, `/payments/${encodeURIComponent(args.paymentId)}/refunds${query({ limit: args.limit, offset: args.offset })}`),
      ),
  }),
  defineTool({
    name: 'get_reporting_currency',
    description:
      'Read the currency an Application reports in: the one its stats lead with and the one offered first for a new price or coupon. Nothing is converted into it. Returns `{reportingCurrency, name}`. Uses REKEY_OPERATOR_TOKEN (`billing:read`).',
    inputSchema: ApplicationArgs,
    execute: (c, args) => read(c, app(args.applicationId, '/billing/reporting-currency')),
  }),
  defineTool({
    name: 'get_billing_stats',
    description:
      "One Application's revenue and subscription stats: subscription counters, MRR, 30-day revenue, unverified payments still held and a 12-month revenue series. " +
      `Money is reported per currency and never added across currencies: \`mrr\`, \`revenueLast30d\`, \`unverified\` and \`monthlyRevenue\` each hold one entry per currency, the reporting currency first, and every \`…Cents\` field is an ${MINOR_UNITS} despite its name. There is no converted total. \`unpricedLiveSubscriptions\` counts live subscriptions on a plan with a flat price that record no price of their own, zero on a healthy Application. Uses REKEY_OPERATOR_TOKEN (\`billing:read\`).`,
    inputSchema: ApplicationArgs,
    execute: (c, args) => read(c, app(args.applicationId, '/billing/stats')),
  }),
  defineTool({
    name: 'set_plan_price',
    description:
      'WRITE: Add a price in another currency to a plan, or change one. The route creates the price when the plan has none in that currency and changes it otherwise. ' +
      "`amount` can change only until a provider has registered the price (PLAN_PRICE_IMMUTABLE after that) or a subscription, an open checkout, a payment or a credit grant names it (PLAN_PRICE_REFERENCED: remove the price once nobody is on it, then set the new amount); `countries` can change at any time. The plan's default price is not changed here (PLAN_PRICE_IS_DEFAULT). " +
      WRITE_NOTE +
      'Use this only when the user explicitly asks to add or change a price.',
    inputSchema: SetPlanPriceArgs,
    execute: (c, args) =>
      c.requestAsOperator(
        'PUT',
        app(args.applicationId, `/plans/${encodeURIComponent(args.plan)}/prices/${encodeURIComponent(args.currency.toUpperCase())}`),
        bodyOf(args, ['applicationId', 'plan', 'currency']),
        WRITE,
      ),
  }),
  defineTool({
    name: 'archive_plan_price',
    description:
      'WRITE: Stop selling a plan in one currency. The price row is kept, archived, when a subscription, a payment or a credit grant names it, and deleted when nothing does. ' +
      'Refused with PLAN_PRICE_IN_USE while a live subscription or an open checkout is on the price. ' +
      WRITE_NOTE +
      'Use this only when the user explicitly asks to remove a price.',
    inputSchema: ArchivePlanPriceArgs,
    execute: (c, args) =>
      c.requestAsOperator(
        'DELETE',
        app(args.applicationId, `/plans/${encodeURIComponent(args.plan)}/prices/${encodeURIComponent(args.currency.toUpperCase())}`),
        undefined,
        WRITE,
      ),
  }),
  defineTool({
    name: 'create_coupon',
    description:
      'WRITE: Create a discount coupon. A PERCENT coupon takes `basisPoints` (1500 is 15%) and works in any currency unless `currencies` limits it. ' +
      'An AMOUNT coupon takes `amounts`, one per currency, and works only in those currencies: a checkout in a currency with no entry is refused with COUPON_CURRENCY_NOT_COVERED. ' +
      WRITE_NOTE +
      'Use this only when the user explicitly asks to create a coupon.',
    inputSchema: CreateCouponArgs,
    execute: (c, args) => c.requestAsOperator('POST', app(args.applicationId, '/coupons'), bodyOf(args, ['applicationId']), WRITE),
  }),
  defineTool({
    name: 'update_coupon',
    description:
      'WRITE: Change a coupon. Send at least one field. `amounts` REPLACES the whole set, so send every currency the coupon should keep: a currency left out stops working. ' +
      "A coupon's `discountType` cannot change, and a checkout already open keeps the discount it was opened with. " +
      '`endsAt`, `maxRedemptions` and `maxRedemptionsPerUser` each take a value or null, which removes the end date or the cap. A cap below the redemptions already held (settled ones plus checkouts still open) is refused with COUPON_LIMIT_BELOW_REDEEMED, whose `fix` names the lowest cap accepted. ' +
      WRITE_NOTE +
      'Use this only when the user explicitly asks to change a coupon.',
    inputSchema: UpdateCouponArgs,
    execute: (c, args) =>
      c.requestAsOperator(
        'PATCH',
        app(args.applicationId, `/coupons/${encodeURIComponent(args.code)}`),
        bodyOf(args, ['applicationId', 'code']),
        WRITE,
      ),
  }),
  defineTool({
    name: 'set_reporting_currency',
    description:
      'WRITE: Set the currency an Application reports in. It changes which currency the stats lead with; it changes no price, subscription or payment, and converts nothing. The change is written to the billing log. ' +
      WRITE_NOTE +
      'Use this only when the user explicitly asks to change the reporting currency.',
    inputSchema: SetReportingCurrencyArgs,
    execute: (c, args) =>
      c.requestAsOperator(
        'PUT',
        app(args.applicationId, '/billing/reporting-currency'),
        { reportingCurrency: args.reportingCurrency.toUpperCase() },
        WRITE,
      ),
  }),
  defineTool({
    name: 'create_refund',
    description:
      'WRITE, MOVES MONEY: Ask the provider that took a payment to pay money back, in full or in part, then record the refund. A payment can be refunded more than once, up to its amount. ' +
      'Refunding does not cancel a subscription or take back credits or licences. Repeating the same call is one refund. Returns `{refund, payment}` with the payment\'s new `refundedAmount`. ' +
      WRITE_NOTE +
      'Use this only when the user explicitly asks to refund this payment, and confirm the payment id and the amount with them first.',
    inputSchema: CreateRefundArgs,
    execute: (c, args) =>
      c.requestAsOperator(
        'POST',
        app(args.applicationId, `/payments/${encodeURIComponent(args.paymentId)}/refunds`),
        bodyOf(args, ['applicationId', 'paymentId']),
        WRITE,
      ),
  }),
];
