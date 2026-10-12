/**
 * The billing log's events: one schema per type, joined in a union on `type`.
 *
 * The log is an append-only index of money changes and of decisions that
 * leave no row of their own (why a price was chosen, why a charge was not
 * applied). `Payment`, `Refund`, `Subscription` and `CreditLedger` stay the
 * truth.
 *
 * Privacy is held by the shapes. Every object is strict, so a field nobody
 * declared (an email, an IP address, a user agent) is refused at write, and
 * no declared field is free text: reasons are codes. A person is named by id
 * only, which is what lets an erased end user's events keep pointing at the
 * tombstone.
 */

import { z } from 'zod';

/** How long an event is kept. Diagnostic events can be caused by anyone holding a publishable key. */
export const BILLING_EVENT_TIERS = ['PERMANENT', 'DIAGNOSTIC'] as const;
export type BillingEventTier = (typeof BILLING_EVENT_TIERS)[number];

export const BILLING_EVENT_ACTOR_TYPES = ['system', 'operator', 'end_user', 'provider'] as const;
export type BillingEventActorType = (typeof BILLING_EVENT_ACTOR_TYPES)[number];

/** A machine-readable reason or identifier. Its alphabet cannot spell an email address. */
const Code = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Country = z.string().regex(/^[A-Z]{2}$/);
const Minor = z.number().int();
const Slug = z.string().min(1).max(200);

/** One price: the row, and what it charged when the event happened. */
const Price = z.object({ planPriceId: z.string().nullable(), currency: Currency, amount: Minor.nonnegative() }).strict();

/** Where the buyer was, and how far that can be believed. */
const buyerCountry = {
  buyerCountry: Country.nullable(),
  buyerCountrySource: z.enum(['declared', 'vouched', 'hint']).nullable(),
};

const PRICE_REASON = z.enum(['bound', 'requested', 'country', 'default', 'fallback']);

/** What reconciliation can find wrong between the log and the money rows. */
export const RECONCILIATION_FINDING_KINDS = [
  'payment_without_event',
  'event_without_payment',
  'refund_mismatch',
  'subscription_without_event',
] as const;
export type ReconciliationFindingKind = (typeof RECONCILIATION_FINDING_KINDS)[number];
/** What a coupon takes off and where it applies, as it stood at one moment. */
const CouponTerms = z
  .object({
    active: z.boolean(),
    /** PERCENT: hundredths of a percent. Null on a fixed-amount coupon. */
    basisPoints: Minor.nonnegative().nullable(),
    /** AMOUNT: what it takes off in each currency. Empty on a percentage coupon. */
    amounts: z.array(z.object({ currency: Currency, amountOff: Minor.positive() }).strict()),
    /** The currencies a percentage coupon is limited to. Empty means any. */
    currencies: z.array(Currency),
    planSlugs: z.array(Slug),
    // The three below are absent on entries written before they were logged.
    /** When the coupon stops working, or null for never. */
    endsAt: z.string().datetime().nullable().optional(),
    /** Redemptions allowed in all, or null for no cap. */
    maxRedemptions: z.number().int().positive().nullable().optional(),
    /** Redemptions allowed per buyer, or null for no cap. */
    maxRedemptionsPerUser: z.number().int().positive().nullable().optional(),
  })
  .strict();
const COUPON_KIND = z.enum(['PERCENT', 'AMOUNT']);

/** Why a provider's report of a charge or a refund left no payment or refund row. */
export const NOT_RECORDED_REASONS = [
  'amount_not_storable',
  'payment_unknown',
  'payment_not_refundable',
  'currency_mismatch',
  'exceeds_payment',
] as const;
export type NotRecordedReason = (typeof NOT_RECORDED_REASONS)[number];

/**
 * The diagnostic types the hourly bound counts and aggregates: every
 * DIAGNOSTIC type but `diagnostic.aggregated`, which is the bound's own
 * record. A new diagnostic type is added here, and to `DIAGNOSTIC_REASON`
 * below, or this file does not compile.
 */
export const BOUNDED_DIAGNOSTIC_TYPES = [
  'checkout.opened',
  'checkout.refused',
  'checkout.expired',
  'coupon.refused',
  'reconciliation.finding',
] as const;
export type BoundedDiagnosticType = (typeof BOUNDED_DIAGNOSTIC_TYPES)[number];

/** The `data` each event type carries. */
export const BILLING_EVENT_DATA = {
  'checkout.opened': z
    .object({ planSlug: Slug, priceShown: Price, priceCharged: Price, reason: PRICE_REASON, discountAmount: Minor.nonnegative(), ...buyerCountry })
    .strict(),
  'checkout.price_fallback': z
    .object({ planSlug: Slug, requested: Price, charged: Price, reason: z.enum(['no_provider_for_currency']), ...buyerCountry })
    .strict(),
  'checkout.refused': z
    .object({ planSlug: Slug.nullable(), code: Code, requestedCurrency: Currency.nullable(), ...buyerCountry })
    .strict(),
  'checkout.completed': z
    .object({ planSlug: Slug, priceCharged: Price, discountAmount: Minor.nonnegative(), providerSessionId: z.string().min(1).max(255) })
    .strict(),
  'payment.recorded': z
    .object({
      priceCharged: Price.nullable(),
      discountAmount: Minor.nonnegative(),
      providerPaymentId: z.string().max(255).nullable(),
      verification: z.enum(['verified', 'unverified']),
    })
    .strict(),
  'payment.failed': z.object({ providerPaymentId: z.string().max(255).nullable(), failureCode: Code.nullable() }).strict(),
  'payment.not_applied': z
    .object({
      reason: z.enum(['currency_mismatch', 'amount_out_of_band', 'price_not_on_plan', 'no_subscription', 'duplicate_completion']),
      expected: Price.nullable(),
      providerPaymentId: z.string().max(255).nullable(),
    })
    .strict(),
  'payment.refunded': z
    .object({
      refundedAmount: Minor.positive(),
      totalRefunded: Minor.nonnegative(),
      providerRefundId: z.string().max(255).nullable(),
      initiatedBy: z.enum(['operator', 'provider', 'system']),
      reasonCode: Code.nullable(),
    })
    .strict(),
  'payment.unapplied': z.object({ unappliedPaymentId: z.string(), reasonCode: Code }).strict(),
  'payment.unapplied_resolved': z
    .object({ unappliedPaymentId: z.string(), resolution: z.enum(['refunded', 'entitlement_granted', 'dismissed']) })
    .strict(),
  'subscription.activated': z
    .object({ planSlug: Slug, price: Price.nullable(), via: z.enum(['checkout', 'grant', 'import', 'provider']), trial: z.boolean() })
    .strict(),
  'subscription.canceled': z
    .object({ planSlug: Slug, atPeriodEnd: z.boolean(), cause: z.enum(['operator', 'end_user', 'provider', 'dunning', 'system']) })
    .strict(),
  'subscription.granted': z.object({ planSlug: Slug, price: Price.nullable() }).strict(),
  'subscription.imported': z.object({ planSlug: Slug, price: Price.nullable(), importRunId: z.string().nullable() }).strict(),
  'coupon.redeemed': z.object({ code: Code, planSlug: Slug, discountAmount: Minor.nonnegative(), priceCharged: Price }).strict(),
  'coupon.refused': z.object({ code: Code, planSlug: Slug.nullable(), reasonCode: Code, chargedCurrency: Currency.nullable() }).strict(),
  'credits.granted': z
    .object({ credits: Minor, source: z.enum(['purchase', 'refill', 'operator', 'api_key', 'plan']), balanceAfter: Minor.nullable() })
    .strict(),
  'plan.price_set': z
    .object({
      planSlug: Slug,
      isDefault: z.boolean(),
      before: z.object({ amount: Minor.positive(), countries: z.array(Country) }).strict().nullable(),
      after: z.object({ amount: Minor.positive(), countries: z.array(Country) }).strict(),
    })
    .strict(),
  'plan.price_archived': z.object({ planSlug: Slug, amount: Minor.positive(), outcome: z.enum(['archived', 'deleted']) }).strict(),
  'plan.local_prices_changed': z
    .object({ planSlug: Slug, before: z.enum(['inherit', 'trusted', 'off']), after: z.enum(['inherit', 'trusted', 'off']) })
    .strict(),
  'provider.currencies_changed': z.object({ before: z.array(Currency), after: z.array(Currency) }).strict(),
  'settings.local_prices_changed': z.object({ before: z.enum(['trusted', 'any']), after: z.enum(['trusted', 'any']) }).strict(),
  'settings.reporting_currency_changed': z.object({ before: Currency.nullable(), after: Currency }).strict(),
  'subscription.priced': z
    .object({
      planSlug: Slug,
      before: Price.nullable(),
      after: Price,
      cause: z.enum(['checkout', 'first_payment', 'grant', 'import', 'provider']),
    })
    .strict(),
  'checkout.expired': z
    .object({ planSlug: Slug.nullable(), reason: z.enum(['timed_out', 'payment_failed', 'mode_mismatch']) })
    .strict(),
  /**
   * Stands for diagnostic events that were counted and not written one by
   * one: past a threshold per Application, type, reason and hour, the log
   * keeps one row per window with how many it left out.
   */
  'diagnostic.aggregated': z
    .object({
      eventType: z.enum(BOUNDED_DIAGNOSTIC_TYPES),
      reason: Code,
      windowStart: z.string().datetime(),
      suppressed: Minor.positive(),
    })
    .strict(),
  /**
   * A disagreement between the log and the money rows, found by
   * reconciliation. The envelope names the payment or subscription; the
   * totals are set for `refund_mismatch` and null otherwise.
   */
  'reconciliation.finding': z
    .object({
      kind: z.enum(RECONCILIATION_FINDING_KINDS),
      refundedOnPayment: Minor.nonnegative().nullable(),
      refundRowsTotal: Minor.nonnegative().nullable(),
      refundEventsTotal: Minor.nonnegative().nullable(),
    })
    .strict(),
  /**
   * A provider reported money moving and Rekey could not record it as a
   * payment or a refund: the amount is not one a payment row can hold, or a
   * refund names a payment that is not on record or that cannot take it. The
   * money is at the provider. The envelope names the payment when one exists.
   */
  'payment.not_recorded': z
    .object({
      kind: z.enum(['charge', 'failed_charge', 'refund']),
      reason: z.enum(NOT_RECORDED_REASONS),
      providerPaymentId: z.string().max(255).nullable(),
      providerRefundId: z.string().max(255).nullable(),
      /** The amount as the provider reported it. Text, because it may not be a number a row can hold. */
      reportedAmount: z.string().max(40).nullable(),
    })
    .strict(),
  'coupon.created': z.object({ code: Code, discountType: COUPON_KIND, terms: CouponTerms }).strict(),
  'coupon.changed': z.object({ code: Code, discountType: COUPON_KIND, before: CouponTerms, after: CouponTerms }).strict(),
  'settings.unavailable_currency_changed': z
    .object({ before: z.enum(['fallback', 'refuse']), after: z.enum(['fallback', 'refuse']) })
    .strict(),
} as const;

export type BillingEventType = keyof typeof BILLING_EVENT_DATA;

export const BILLING_EVENT_TYPES = Object.keys(BILLING_EVENT_DATA) as BillingEventType[];

/** The retention tier of each type. Refusals and opened checkouts are diagnostic. */
export const BILLING_EVENT_TIER = {
  'checkout.opened': 'DIAGNOSTIC',
  'checkout.price_fallback': 'PERMANENT',
  'checkout.refused': 'DIAGNOSTIC',
  'checkout.completed': 'PERMANENT',
  'payment.recorded': 'PERMANENT',
  'payment.failed': 'PERMANENT',
  'payment.not_applied': 'PERMANENT',
  'payment.refunded': 'PERMANENT',
  'payment.unapplied': 'PERMANENT',
  'payment.unapplied_resolved': 'PERMANENT',
  'subscription.activated': 'PERMANENT',
  'subscription.canceled': 'PERMANENT',
  'subscription.granted': 'PERMANENT',
  'subscription.imported': 'PERMANENT',
  'coupon.redeemed': 'PERMANENT',
  'coupon.refused': 'DIAGNOSTIC',
  'credits.granted': 'PERMANENT',
  'plan.price_set': 'PERMANENT',
  'plan.price_archived': 'PERMANENT',
  'plan.local_prices_changed': 'PERMANENT',
  'provider.currencies_changed': 'PERMANENT',
  'settings.local_prices_changed': 'PERMANENT',
  'settings.reporting_currency_changed': 'PERMANENT',
  'subscription.priced': 'PERMANENT',
  'checkout.expired': 'DIAGNOSTIC',
  'diagnostic.aggregated': 'DIAGNOSTIC',
  'reconciliation.finding': 'DIAGNOSTIC',
  'coupon.created': 'PERMANENT',
  'coupon.changed': 'PERMANENT',
  'payment.not_recorded': 'PERMANENT',
  'settings.unavailable_currency_changed': 'PERMANENT',
} as const satisfies Record<BillingEventType, BillingEventTier>;

export type DiagnosticBillingEventType = {
  [T in BillingEventType]: (typeof BILLING_EVENT_TIER)[T] extends 'DIAGNOSTIC' ? T : never;
}[BillingEventType];

/** What every event carries beside its `type` and `data`. */
const envelope = {
  applicationId: z.string().min(1),
  /** When it happened, ISO 8601. Left out, it is when it was recorded. */
  occurredAt: z.string().datetime().optional(),
  /**
   * Writes with the same Application, type and key are one event. Left out,
   * it is the provider's event id when there is one, so a redelivered webhook
   * writes once, and otherwise unique to this write.
   */
  dedupeKey: z.string().min(1).max(255).optional(),
  actor: z.object({ type: z.enum(BILLING_EVENT_ACTOR_TYPES), id: z.string().min(1).max(255).optional() }).strict(),
  endUserId: z.string().optional(),
  subscriptionId: z.string().optional(),
  checkoutSessionId: z.string().optional(),
  paymentId: z.string().optional(),
  refundId: z.string().optional(),
  planId: z.string().optional(),
  planPriceId: z.string().optional(),
  couponId: z.string().optional(),
  provider: Code.optional(),
  providerEventId: z.string().min(1).max(255).optional(),
  currency: Currency.optional(),
  amount: Minor.optional(),
};

const EMAIL_SHAPED = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * The path of the first string anywhere in `value` that looks like an email
 * address. The id fields are plain strings, and a provider or a caller can put
 * anything in one.
 */
function emailShapedValue(value: unknown, path: Array<string | number> = []): Array<string | number> | null {
  if (typeof value === 'string') return EMAIL_SHAPED.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = emailShapedValue(item, [...path, index]);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const found = emailShapedValue(item, [...path, key]);
      if (found !== null) return found;
    }
  }
  return null;
}

function eventSchema<T extends BillingEventType>(type: T) {
  return z.object({ type: z.literal(type), ...envelope, data: BILLING_EVENT_DATA[type] }).strict();
}

/**
 * Every billing event a writer may record, discriminated on `type`.
 *
 * @example
 * BillingEventSchema.parse({
 *   type: 'plan.price_set',
 *   applicationId: 'app_1',
 *   actor: { type: 'operator', id: 'op_1' },
 *   planId: 'plan_1',
 *   planPriceId: 'pp_1',
 *   currency: 'INR',
 *   amount: 149900,
 *   data: { planSlug: 'pro', isDefault: false, before: null, after: { amount: 149900, countries: [] } },
 * });
 */
export const BillingEventSchema = z
  .discriminatedUnion('type', [
  eventSchema('checkout.opened'),
  eventSchema('checkout.price_fallback'),
  eventSchema('checkout.refused'),
  eventSchema('checkout.completed'),
  eventSchema('payment.recorded'),
  eventSchema('payment.failed'),
  eventSchema('payment.not_applied'),
  eventSchema('payment.refunded'),
  eventSchema('payment.unapplied'),
  eventSchema('payment.unapplied_resolved'),
  eventSchema('subscription.activated'),
  eventSchema('subscription.canceled'),
  eventSchema('subscription.granted'),
  eventSchema('subscription.imported'),
  eventSchema('coupon.redeemed'),
  eventSchema('coupon.refused'),
  eventSchema('credits.granted'),
  eventSchema('plan.price_set'),
  eventSchema('plan.price_archived'),
  eventSchema('plan.local_prices_changed'),
  eventSchema('provider.currencies_changed'),
  eventSchema('settings.local_prices_changed'),
  eventSchema('settings.reporting_currency_changed'),
  eventSchema('subscription.priced'),
  eventSchema('checkout.expired'),
  eventSchema('diagnostic.aggregated'),
  eventSchema('reconciliation.finding'),
  eventSchema('coupon.created'),
  eventSchema('coupon.changed'),
  eventSchema('payment.not_recorded'),
  eventSchema('settings.unavailable_currency_changed'),
  ])
  .superRefine((event, ctx) => {
    const path = emailShapedValue(event);
    if (path !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'A billing event names a person by id, never by email address.' });
    }
  });

export type BillingEvent = z.infer<typeof BillingEventSchema>;

/** The event of one type. */
export type BillingEventOf<T extends BillingEventType> = Extract<BillingEvent, { type: T }>;

/** The `data` of one type. */
export type BillingEventData<T extends BillingEventType> = BillingEventOf<T>['data'];

/**
 * What a diagnostic event is counted under for the hourly bound: its reason.
 * Every value is a code the API chose, never text a caller sent, so the
 * number of distinct keys per Application is fixed.
 *
 * @example
 * diagnosticReasonOf({ type: 'checkout.refused', data: { code: 'BILLING_NO_PROVIDER_FOR_CURRENCY' } }); // 'BILLING_NO_PROVIDER_FOR_CURRENCY'
 */
export function diagnosticReasonOf(event: { type: string; data: object }): string {
  if (!isBoundedDiagnosticType(event.type)) return 'unknown';
  return DIAGNOSTIC_REASON[event.type](event.data as ReasonFields) ?? 'unknown';
}

type ReasonFields = { code?: string; reasonCode?: string; reason?: string; kind?: string };

/** Where each bounded type keeps the code it is counted under. */
const DIAGNOSTIC_REASON: Record<BoundedDiagnosticType, (data: ReasonFields) => string | undefined> = {
  'checkout.refused': (data) => data.code,
  'coupon.refused': (data) => data.reasonCode,
  'checkout.opened': (data) => data.reason,
  'checkout.expired': (data) => data.reason,
  'reconciliation.finding': (data) => data.kind,
};

function isBoundedDiagnosticType(type: string): type is BoundedDiagnosticType {
  return (BOUNDED_DIAGNOSTIC_TYPES as readonly string[]).includes(type);
}

type UnboundedDiagnosticType = Exclude<DiagnosticBillingEventType, BoundedDiagnosticType | 'diagnostic.aggregated'>;
/** Fails to compile, naming the type, when a DIAGNOSTIC type is missing from `BOUNDED_DIAGNOSTIC_TYPES`. */
export const EVERY_DIAGNOSTIC_TYPE_IS_BOUNDED: [UnboundedDiagnosticType] extends [never] ? true : UnboundedDiagnosticType = true;
