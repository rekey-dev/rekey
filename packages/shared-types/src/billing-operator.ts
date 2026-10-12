/**
 * Shapes of the operator billing routes that carry money: refunds, a plan's
 * prices, the providers' currencies, and the payloads of the outbound
 * `payment.*` and `subscription.*` webhooks.
 *
 * Every amount is an integer in the minor unit of its currency (cents for
 * USD, whole yen for JPY). Write one for a person with `formatMoney`.
 */

import { z } from 'zod';

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export const REFUND_INITIATORS = ['operator', 'provider', 'system'] as const;

/**
 * One refund of a payment, as `GET` and `POST
 * /tenant/applications/:id/payments/:paymentId/refunds` return it.
 *
 * @example
 * { id: 'rf_1', paymentId: 'pay_1', providerRefundId: 're_1', amount: 500, currency: 'USD',
 *   status: 'succeeded', reason: 'Duplicate charge', initiatedBy: 'operator', createdAt: '2026-10-12T09:00:00.000Z' }
 */
export const RefundDtoSchema = z.object({
  id: z.string(),
  paymentId: z.string().describe('The payment refunded.'),
  /** The provider's id for the refund. Null when the provider's event named none. */
  providerRefundId: z.string().nullable().describe('The provider\'s id for the refund. Null when the provider\'s event named none.'),
  /** Minor units of `currency`. */
  amount: z.number().int().describe('Minor units of `currency`.'),
  /** The payment's currency, upper-case ISO 4217. A refund is never in another. */
  currency: z.string().describe('The payment\'s currency, upper-case ISO 4217. A refund is never in another.'),
  /** A failed refund counts for nothing in the payment's `refundedAmount`. */
  status: z.enum(REFUND_STATUSES).describe('A failed refund counts for nothing in the payment\'s `refundedAmount`.'),
  reason: z.string().nullable().describe('The reason kept on the refund, when one was given.'),
  /** Who started it: an operator through Rekey, the provider, or Rekey itself. */
  initiatedBy: z.enum(REFUND_INITIATORS).describe('Who started it: an operator through Rekey, the provider, or Rekey itself.'),
  createdAt: z.string().datetime(),
});
export type RefundDto = z.infer<typeof RefundDtoSchema>;

/**
 * Why a payment cannot be refunded through Rekey, as the payment reads and
 * the refund route both judge it before any provider is asked.
 *
 * - `payment_not_succeeded`: the payment is pending or failed, so nothing was collected.
 * - `no_provider_charge_id`: no provider charge id was recorded for it.
 * - `already_refunded`: all of it has been refunded.
 * - `provider_unknown`: Rekey has no record of which provider took it.
 * - `provider_cannot_refund`: Rekey cannot issue refunds through that provider.
 * - `provider_not_configured`: that provider has no credentials on the Application now.
 */
export const REFUND_BLOCKED_REASONS = [
  'payment_not_succeeded',
  'no_provider_charge_id',
  'already_refunded',
  'provider_unknown',
  'provider_cannot_refund',
  'provider_not_configured',
] as const;
export const RefundBlockedReasonSchema = z.enum(REFUND_BLOCKED_REASONS);
export type RefundBlockedReason = z.infer<typeof RefundBlockedReasonSchema>;

const REFUND_BLOCKED_MESSAGES: Record<RefundBlockedReason, string> = {
  payment_not_succeeded: 'This payment did not succeed, so no money was collected and there is nothing to refund.',
  no_provider_charge_id: 'No provider charge id was recorded for this payment, so Rekey cannot ask anyone to refund it. Refund it in the provider dashboard.',
  already_refunded: 'This payment has been refunded in full. Nothing remains.',
  provider_unknown: 'Rekey has no record of which provider took this payment, so it cannot ask one to refund it. Refund it in the provider dashboard.',
  provider_cannot_refund: 'Rekey cannot issue refunds through the provider that took this payment. Refund it in the provider dashboard.',
  provider_not_configured: 'The provider that took this payment has no credentials on this Application now. Store its credentials again, or refund it in the provider dashboard.',
};

/**
 * Why a payment cannot be refunded through Rekey, as a sentence for a person.
 *
 * @example
 * refundBlockedMessage('already_refunded'); // 'This payment has been refunded in full. Nothing remains.'
 */
export function refundBlockedMessage(reason: RefundBlockedReason): string {
  return REFUND_BLOCKED_MESSAGES[reason];
}

/**
 * `POST /tenant/applications/:id/payments/:paymentId/refunds`.
 *
 * @example
 * { amount: 500, reason: 'Duplicate charge' }
 */
export const CreateRefundRequestSchema = z
  .object({
    /** Minor units of the payment's currency. Left out, everything not yet refunded. */
    amount: z.number().int().positive().optional(),
    /** Kept on the refund, and sent to the provider where it takes one. */
    reason: z.string().min(1).max(500).optional(),
    /**
     * What makes two requests the same refund at the provider. Left out, it
     * is derived from the payment, what was already refunded and the amount,
     * so a repeated request is one refund.
     */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CreateRefundRequest = z.infer<typeof CreateRefundRequestSchema>;

/** A payment after a refund: its running refunded total and the status that follows from it. */
export const RefundedPaymentDtoSchema = z.object({
  id: z.string(),
  /** What the payment charged, minor units of `currency`. */
  amount: z.number().int().describe('What the payment charged, minor units of `currency`.'),
  currency: z.string().describe('Upper-case ISO 4217.'),
  /** The sum of this payment's refunds that have not failed, minor units of `currency`. */
  refundedAmount: z.number().int().describe('The sum of this payment\'s refunds that have not failed, minor units of `currency`.'),
  status: z.enum(['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED']).describe('SUCCEEDED when nothing is refunded, PARTIALLY_REFUNDED, or REFUNDED when all of it is.'),
});
export type RefundedPaymentDto = z.infer<typeof RefundedPaymentDtoSchema>;

/** What issuing a refund answers: the refund, and the payment with its new total. */
export const RefundResultDtoSchema = z.object({
  refund: RefundDtoSchema.describe('The refund just recorded.'),
  payment: RefundedPaymentDtoSchema.describe('The payment with its new refunded total.'),
});
export type RefundResultDto = z.infer<typeof RefundResultDtoSchema>;

/**
 * `PUT /tenant/applications/:id/plans/:planId/prices/:currency`: add a price
 * in a currency, or change one. `amount` is required to add a price and can
 * change only until a provider has registered it. `countries` can change at
 * any time.
 *
 * @example
 * { amount: 149900, countries: ['IN'] }
 */
export const SetPlanPriceRequestSchema = z
  .object({
    /** Minor units of the currency in the path, above 0. */
    amount: z.number().int().positive().optional(),
    /** ISO 3166-1 alpha-2. Empty means wherever the currency is the local one. */
    countries: z.array(z.string()).max(250).optional(),
  })
  .strict();
export type SetPlanPriceRequest = z.infer<typeof SetPlanPriceRequestSchema>;

/**
 * A plan's default price as a request states it.
 *
 * @example
 * { currency: 'USD', amount: 1900 }
 */
export const PlanPriceInputSchema = z
  .object({
    /** ISO 4217. */
    currency: z.string().length(3),
    /** Minor units of `currency`, above 0: 1900 is $19.00 and 5000 is ¥5,000. */
    amount: z.number().int().positive(),
  })
  .strict();
export type PlanPriceInput = z.infer<typeof PlanPriceInputSchema>;

/**
 * `POST /tenant/applications/:id/plans`. `price` is the default price: leave
 * it out for a free plan, or for a USAGE plan with no base fee. Each `kind`
 * needs its own fields: CREDIT takes `creditsAmount`, LICENSE takes
 * `licenseKind` (with `licenseDurationDays` for TIMED and
 * `licenseSeatsAllowed` for SEATS), USAGE takes `meterSlug`.
 *
 * @example
 * { slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 }, interval: 'MONTH' }
 */
export const CreatePlanRequestSchema = z.object({
  slug: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  price: PlanPriceInputSchema.optional(),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  kind: z.enum(['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT']).optional(),
  licenseKind: z.enum(['PERPETUAL', 'TIMED', 'SEATS']).optional(),
  licenseSeatsAllowed: z.number().int().positive().optional(),
  licenseDurationDays: z.number().int().positive().optional(),
  meterSlug: z.string().min(1).max(40).optional(),
  creditsAmount: z.number().int().positive().optional(),
  /** SUBSCRIPTION plans only, 1 to 365. */
  trialDays: z.number().int().min(1).max(365).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequestSchema>;

/**
 * `PATCH /tenant/applications/:id/plans/:slug`: any subset, at least one
 * field. `price` and `interval` are accepted only until a provider has
 * registered the plan. `price: null` makes the plan free. `trialDays: 0`
 * clears a trial. `localPrices` can change at any time, and the change is
 * written to the billing log as `plan.local_prices_changed`.
 *
 * @example
 * { name: 'Pro (annual)', price: { currency: 'USD', amount: 19000 }, interval: 'YEAR' }
 * { localPrices: 'OFF' }
 */
export const UpdatePlanRequestSchema = z.object({
  active: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
  price: PlanPriceInputSchema.nullable().optional(),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  /**
   * Whether a buyer's country may select one of this plan's prices in another
   * currency. `INHERIT` follows the Application's `localPrices`. `TRUSTED`
   * needs a country your server declared or a trusted proxy vouched for,
   * whatever the Application allows. `OFF` never does: every buyer is charged
   * the default price unless your server names a `currency` at checkout.
   */
  localPrices: z.enum(['INHERIT', 'TRUSTED', 'OFF']).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdatePlanRequest = z.infer<typeof UpdatePlanRequestSchema>;

/** How one provider stands on one Application. Never carries a credential. */
export const BillingCredentialStatusDtoSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['test', 'live']),
  /** ISO 3166-1 alpha-2 codes whose buyers are routed here first. */
  countries: z.array(z.string()),
  /** The currencies this account charges, upper-case ISO 4217, chosen from the provider's own list. Empty means none. */
  currencies: z.array(z.string()),
  /** Stored currencies the provider does not offer at all. Routing skips them: remove them and save. */
  unsupportedCurrencies: z.array(z.string()),
  priority: z.number().int(),
  webhookConfigured: z.boolean(),
});
export type BillingCredentialStatusDto = z.infer<typeof BillingCredentialStatusDtoSchema>;

/** One row of `GET /tenant/applications/:id/billing-credentials`. */
export const BillingCredentialDtoSchema = BillingCredentialStatusDtoSchema.extend({
  provider: z.string(),
  configured: z.literal(true),
});
export type BillingCredentialDto = z.infer<typeof BillingCredentialDtoSchema>;

/**
 * One registered provider module with what it can charge, as
 * `GET /tenant/applications/:id/billing/providers` lists it.
 */
export const BillingProviderModuleDtoSchema = z.object({
  name: z.string(),
  label: z.string(),
  docsUrl: z.string(),
  defaultCountries: z.array(z.string()),
  /** Every currency the provider can charge, or `all-sellable` for every currency a price may be in. */
  supportedCurrencies: z.union([z.array(z.string()), z.literal('all-sellable')]),
  /** What an account usually charges. A credential row saved without a list starts with these. Never empty. */
  preselectedCurrencies: z.array(z.string()),
  priority: z.number().int(),
  capabilities: z.record(z.union([z.boolean(), z.record(z.boolean())])),
  /** The fields its credential form asks for. Never a stored value. */
  credentialFields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      secret: z.boolean(),
      optional: z.boolean(),
      placeholder: z.string().optional(),
      help: z.string().optional(),
      pattern: z.object({ message: z.string() }).optional(),
    }),
  ),
  configured: z.boolean(),
  /** Null until the provider is configured for this Application. */
  status: BillingCredentialStatusDtoSchema.nullable(),
});
export type BillingProviderModuleDto = z.infer<typeof BillingProviderModuleDtoSchema>;

/** The body of `GET /tenant/applications/:id/billing/providers`. */
export const BillingProviderModulesDtoSchema = z.object({ providers: z.array(BillingProviderModuleDtoSchema) });
export type BillingProviderModulesDto = z.infer<typeof BillingProviderModulesDtoSchema>;

/**
 * `data` of the outbound `payment.succeeded`, `payment.failed` and
 * `payment.refunded` webhooks.
 *
 * `verification` is `unverified` for a charge Rekey recorded and did not
 * apply: it matched no subscription, or not the price it was for. Nothing was
 * granted for it and it is not revenue until an operator resolves it.
 *
 * `refund` is present on `payment.refunded` only: the one refund just
 * recorded. `payment.refundedAmount` is the running total after it.
 *
 * @example
 * { payment: { id: 'pay_1', endUserId: 'eu_1', subscriptionId: 'sub_1', planSlug: 'pro', amount: 1900,
 *     currency: 'USD', status: 'PARTIALLY_REFUNDED', refundedAmount: 500, verification: 'verified',
 *     providerPaymentId: 'in_1', description: null, createdAt: '2026-10-12T09:00:00.000Z' },
 *   refund: { id: 'rf_1', amount: 500, currency: 'USD', status: 'succeeded', providerRefundId: 're_1',
 *     createdAt: '2026-10-12T10:00:00.000Z' } }
 */
export interface PaymentWebhookData {
  payment: {
    id: string;
    endUserId: string | null;
    subscriptionId: string | null;
    /** The plan of the subscription the payment is linked to, when it is linked to one. */
    planSlug: string | null;
    /** Minor units of `currency`. */
    amount: number;
    /** Upper-case ISO 4217. */
    currency: string;
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | (string & {});
    /** The sum of this payment's refunds that have not failed, minor units of `currency`. */
    refundedAmount: number;
    verification: 'verified' | 'unverified';
    providerPaymentId: string | null;
    description: string | null;
    createdAt: string;
  };
  refund?: {
    id: string;
    /** Minor units of `currency`. */
    amount: number;
    currency: string;
    status: (typeof REFUND_STATUSES)[number];
    providerRefundId: string | null;
    createdAt: string;
  };
}

/**
 * `data` of the outbound `subscription.*` webhooks.
 *
 * `amount` and `currency` are what this subscriber pays each period: the
 * price their checkout, grant or import fixed, which can differ from the
 * plan's default price. A subscription with no price of its own carries
 * `amount: 0` and `currency: null`.
 *
 * `entitlements` is absent when Rekey could not resolve it. That means
 * unknown, never "grants nothing".
 */
export interface SubscriptionWebhookData {
  subscription: {
    id: string;
    endUserId: string;
    organizationId: string | null;
    status: string;
    provider: string | null;
    planSlug: string;
    planName: string;
    planKind: string;
    /** Minor units of `currency`. 0 when the subscription has no price of its own. */
    amount: number;
    /** Upper-case ISO 4217, or null when the subscription has no price of its own. */
    currency: string | null;
    interval: 'MONTH' | 'YEAR';
    entitlements?: Array<{
      kind: 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
      key: string;
      valueType: 'BOOL' | 'INT' | 'STRING' | null;
      value: string | null;
      quantity: number | null;
      /** USAGE only: credits charged per unit past `quantity`. Null means a hard cap. */
      creditsPerUnit: number | null;
      licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
      rollover: boolean;
    }>;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    canceledAt: string | null;
    createdAt: string;
  };
}
