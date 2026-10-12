/**
 * The billing log as an operator reads it: one entry per stored event, the
 * page they come in, the reconciliation report, and the outbox status the
 * super-admin sees.
 *
 * An entry carries the same `data` its event was written with
 * (`BILLING_EVENT_DATA`), so a reader narrows on `type` and gets the fields of
 * that type and no others.
 */

import { z } from 'zod';
import {
  BILLING_EVENT_ACTOR_TYPES,
  BILLING_EVENT_DATA,
  BILLING_EVENT_TIERS,
  BILLING_EVENT_TYPES,
  RECONCILIATION_FINDING_KINDS,
  type BillingEventType,
} from './billing-events.js';

const Id = z.string().nullable();

const entryEnvelope = {
  id: z.string(),
  /** The ordering cursor: a 64-bit integer as a decimal string. Later events have larger values. */
  seq: z.string().regex(/^\d+$/).describe('The ordering cursor: a 64-bit integer as a decimal string. Later events have larger values.'),
  applicationId: z.string().describe('The Application the event belongs to.'),
  tier: z.enum(BILLING_EVENT_TIERS).describe('PERMANENT events live as long as the Application. DIAGNOSTIC events are pruned after 90 days.'),
  /** When it happened, ISO 8601. A provider's own time for a webhook. */
  occurredAt: z.string().datetime().describe('When it happened, ISO 8601. A provider\'s own time for a webhook.'),
  /** When Rekey wrote it. */
  recordedAt: z.string().datetime().describe('When Rekey wrote it.'),
  actor: z
    .object({
      type: z.enum(BILLING_EVENT_ACTOR_TYPES).describe('`system`, `operator`, `end_user` or `provider`.'),
      id: Id.describe('The id of the operator or end user. Null for the system and for a provider.'),
    })
    .strict()
    .describe('Who caused the event: the system, an operator, an end user or a provider, by id.'),
  endUserId: Id.describe('The end user the event is about, when there is one.'),
  subscriptionId: Id.describe('The subscription the event names, when there is one.'),
  checkoutSessionId: Id.describe('The checkout the event names, when there is one.'),
  paymentId: Id.describe('The payment the event names, when there is one.'),
  refundId: Id.describe('The refund the event names, when there is one.'),
  planId: Id.describe('The plan the event names, when there is one.'),
  planPriceId: Id.describe('The price row the event names, when there is one.'),
  couponId: Id.describe('The coupon the event names, when there is one.'),
  provider: Id.describe('The payment provider involved, when there is one.'),
  providerEventId: Id.describe('The provider\'s own id for the event that caused this entry, when a webhook did.'),
  /** Upper-case ISO 4217, when the event is about money. */
  currency: Id.describe('Upper-case ISO 4217, when the event is about money.'),
  /** Smallest unit of `currency`. */
  amount: z.number().int().nullable().describe('Smallest unit of `currency`.'),
};

function entrySchema<T extends BillingEventType>(type: T) {
  return z
    .object({
      type: z.literal(type).describe('The event type. It decides the fields of `data`.'),
      ...entryEnvelope,
      // No `.describe()` here: it returns the schema's own type, which the
      // compiler then prints in full for every event type and refuses to emit.
      data: BILLING_EVENT_DATA[type],
    })
    .strict();
}

/**
 * One event of an Application's billing log.
 *
 * @example
 * const entry = BillingLogEntrySchema.parse(row);
 * if (entry.type === 'checkout.price_fallback') entry.data.requested.currency; // 'INR'
 */
export const BillingLogEntrySchema = z.discriminatedUnion('type', [
  entrySchema('checkout.opened'),
  entrySchema('checkout.price_fallback'),
  entrySchema('checkout.refused'),
  entrySchema('checkout.completed'),
  entrySchema('checkout.expired'),
  entrySchema('payment.recorded'),
  entrySchema('payment.failed'),
  entrySchema('payment.not_applied'),
  entrySchema('payment.refunded'),
  entrySchema('payment.unapplied'),
  entrySchema('payment.unapplied_resolved'),
  entrySchema('subscription.activated'),
  entrySchema('subscription.canceled'),
  entrySchema('subscription.granted'),
  entrySchema('subscription.imported'),
  entrySchema('subscription.priced'),
  entrySchema('coupon.redeemed'),
  entrySchema('coupon.refused'),
  entrySchema('coupon.created'),
  entrySchema('coupon.changed'),
  entrySchema('payment.not_recorded'),
  entrySchema('credits.granted'),
  entrySchema('plan.price_set'),
  entrySchema('plan.price_archived'),
  entrySchema('plan.local_prices_changed'),
  entrySchema('provider.currencies_changed'),
  entrySchema('settings.local_prices_changed'),
  entrySchema('settings.reporting_currency_changed'),
  entrySchema('settings.unavailable_currency_changed'),
  entrySchema('diagnostic.aggregated'),
  entrySchema('reconciliation.finding'),
]);
export type BillingLogEntry = z.infer<typeof BillingLogEntrySchema>;

/** Fails to compile when an event type is added without an entry above. */
type MissingEntry = Exclude<BillingEventType, BillingLogEntry['type']>;
export const BILLING_LOG_ENTRY_TYPES_COMPLETE: MissingEntry extends never ? true : never = true;

export const BILLING_LOG_DEFAULT_LIMIT = 50;
export const BILLING_LOG_MAX_LIMIT = 200;

/** What a log read can add to a page. `actors` resolves the people its entries name. */
export const BILLING_LOG_INCLUDES = ['actors'] as const;
export type BillingLogInclude = (typeof BILLING_LOG_INCLUDES)[number];

const EventType = z.enum(BILLING_EVENT_TYPES as [BillingEventType, ...BillingEventType[]]);
const EntityId = z.string().min(1).max(64);

/**
 * The query of `GET /tenant/applications/:id/billing/events`. Every filter
 * narrows; none widens past the Application in the path.
 *
 * @example
 * BillingLogQuerySchema.parse({ type: 'checkout.price_fallback,checkout.refused', currency: 'inr', limit: '20' });
 * BillingLogQuerySchema.parse({ include: 'actors' }).include; // ['actors']
 */
export const BillingLogQuerySchema = z
  .object({
    /** The `nextCursor` of the previous page. Entries older than it are returned. */
    cursor: z.string().regex(/^\d{1,19}$/).optional(),
    limit: z.coerce.number().int().min(1).max(BILLING_LOG_MAX_LIMIT).default(BILLING_LOG_DEFAULT_LIMIT),
    /** One event type, or several separated by commas. */
    type: z
      .string()
      .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part !== ''))
      .pipe(z.array(EventType).min(1).max(BILLING_EVENT_TYPES.length))
      .optional(),
    tier: z.enum(BILLING_EVENT_TIERS).optional(),
    endUserId: EntityId.optional(),
    subscriptionId: EntityId.optional(),
    paymentId: EntityId.optional(),
    /** ISO 4217, any case. */
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    /** Events that happened at or after this instant, ISO 8601. */
    from: z.string().datetime().optional(),
    /** Events that happened before this instant, ISO 8601. */
    to: z.string().datetime().optional(),
    /** `actors`: also say who the end users and operators named on the page are. */
    include: z
      .string()
      .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part !== ''))
      .pipe(z.array(z.enum(BILLING_LOG_INCLUDES)).min(1).max(BILLING_LOG_INCLUDES.length))
      .optional(),
  })
  .strict();
export type BillingLogQuery = z.infer<typeof BillingLogQuerySchema>;

/**
 * An end user named on a page of the log, as they stand when the page is
 * read. `erased` is an end user whose personal data was erased: the email is
 * gone and is never the one they had. `unknown` is an id with no end user
 * behind it in this Application any more.
 */
export const BillingLogEndUserSchema = z
  .object({
    id: z.string(),
    state: z.enum(['known', 'erased', 'unknown']).describe('`known`, `erased` (personal data erased, no email) or `unknown` (no end user with this id in the Application any more).'),
    email: z.string().nullable().describe('The email the end user has now. Null unless `state` is `known`.'),
  })
  .strict();
export type BillingLogEndUser = z.infer<typeof BillingLogEndUserSchema>;

/** An operator named on a page of the log. Still `known` after leaving the workspace, while the account exists. */
export const BillingLogOperatorSchema = z
  .object({
    id: z.string(),
    state: z.enum(['known', 'unknown']).describe('`known`, or `unknown` when no operator account has this id any more.'),
    name: z.string().nullable().describe('The name on the operator account. Null when none is set, and when `state` is `unknown`.'),
    email: z.string().nullable().describe('The email of the operator account. Null when `state` is `unknown`.'),
  })
  .strict();
export type BillingLogOperator = z.infer<typeof BillingLogOperatorSchema>;

/**
 * Who the ids on one page of the log are. Looked up when the page is read
 * and never stored in the log.
 *
 * @example
 * const email = page.actors?.endUsers?.find((user) => user.id === entry.endUserId)?.email ?? entry.endUserId;
 */
export const BillingLogActorsSchema = z
  .object({
    /**
     * Every end user an entry of the page names, in `endUserId` or as its
     * actor. Null when the caller may not read end users (the
     * `end-users:read` scope).
     */
    endUsers: z
      .array(BillingLogEndUserSchema)
      .nullable()
      .describe('Every end user an entry of the page names, in `endUserId` or as its actor. Null when the caller lacks the `end-users:read` scope: nothing about an end user is resolved for them.'),
    /** Every operator who is the actor of an entry of the page. */
    operators: z.array(BillingLogOperatorSchema).describe('Every operator who is the actor of an entry of the page.'),
  })
  .strict();
export type BillingLogActors = z.infer<typeof BillingLogActorsSchema>;

/**
 * One page of the log, newest first. `nextCursor` is null on the last page.
 * `actors` is null unless the read asked for `include=actors`.
 */
export const BillingLogPageSchema = z
  .object({
    items: z.array(BillingLogEntrySchema).describe('The entries of this page, newest first.'),
    nextCursor: z.string().nullable().describe('Pass it back as `cursor` for the next page. Null on the last page.'),
    actors: BillingLogActorsSchema.nullable().describe('Who the end users and operators named on this page are, looked up as the page is read. Null unless the read asked for `include=actors`.'),
  })
  .strict();
export type BillingLogPage = z.infer<typeof BillingLogPageSchema>;

/** One disagreement between the log and the money rows. */
export const ReconciliationFindingSchema = z
  .object({
    kind: z.enum(RECONCILIATION_FINDING_KINDS).describe('What disagrees: `payment_without_event`, `event_without_payment`, `refund_mismatch` or `subscription_without_event`.'),
    paymentId: Id.describe('The payment at fault, when the finding is about one.'),
    subscriptionId: Id.describe('The subscription at fault, when the finding is about one.'),
    /** The log entry at fault, for `event_without_payment`. */
    eventSeq: z.string().nullable().describe('The log entry at fault, for `event_without_payment`.'),
    currency: Id.describe('Upper-case ISO 4217 of the payment or event, when it has one.'),
    /** The payment's or event's amount, smallest unit of `currency`. */
    amount: z.number().int().nullable().describe('The payment\'s or event\'s amount, smallest unit of `currency`.'),
    /** `Payment.refundedAmount`, for `refund_mismatch`. */
    refundedOnPayment: z.number().int().nullable().describe('`Payment.refundedAmount`, for `refund_mismatch`.'),
    /** The payment's succeeded `Refund` rows added up, for `refund_mismatch`. */
    refundRowsTotal: z.number().int().nullable().describe('The payment\'s succeeded `Refund` rows added up, for `refund_mismatch`.'),
    /** The payment's `payment.refunded` events added up, for `refund_mismatch`. */
    refundEventsTotal: z.number().int().nullable().describe('The payment\'s `payment.refunded` events added up, for `refund_mismatch`.'),
    /** When the payment, subscription or event at fault was created. */
    at: z.string().datetime().describe('When the payment, subscription or event at fault was created.'),
  })
  .strict();
export type ReconciliationFinding = z.infer<typeof ReconciliationFindingSchema>;

/**
 * `GET /tenant/applications/:id/billing/reconciliation`: the log compared
 * with the payments, refunds and subscriptions of one period.
 */
export const ReconciliationReportSchema = z
  .object({
    applicationId: z.string().describe('The Application compared.'),
    from: z.string().datetime().describe('Start of the period, inclusive.'),
    to: z.string().datetime().describe('End of the period, exclusive.'),
    /**
     * When this Application's log first recorded a payment. Payments older
     * than it were never logged and are not reported as missing. Null when the
     * log holds no payment event yet: the payment check did not run.
     */
    paymentsLoggedSince: z.string().datetime().nullable().describe('When this Application\'s log first recorded a payment. Payments older than it were never logged and are not reported as missing. Null when the log holds no payment event yet: the payment check did not run.'),
    /** The same for subscriptions. */
    subscriptionsLoggedSince: z.string().datetime().nullable().describe('The same for subscriptions.'),
    /** How many rows of each kind the period held. */
    checked: z
      .object({
        payments: z.number().int().describe('Payments created in the period.'),
        refunds: z.number().int().describe('Refunds created in the period.'),
        subscriptions: z.number().int().describe('Subscriptions created in the period.'),
        events: z.number().int().describe('Log entries that happened in the period.'),
      })
      .strict().describe('How many rows of each kind the period held.'),
    counts: z
      .object({
        payment_without_event: z.number().int().describe('Payments the log does not mention.'),
        event_without_payment: z.number().int().describe('Log entries naming a payment that does not exist.'),
        refund_mismatch: z
          .number()
          .int()
          .describe('Payments whose refunds add up differently on the payment, in the refund records and in the log.'),
        subscription_without_event: z.number().int().describe('Subscriptions with no activation entry.'),
      })
      .strict().describe('How many findings of each kind the period holds.'),
    /** At most `RECONCILIATION_MAX_FINDINGS` of each kind, oldest first. */
    findings: z.array(ReconciliationFindingSchema).describe('At most `RECONCILIATION_MAX_FINDINGS` of each kind, oldest first.'),
    /** True when a kind had more findings than are listed. `counts` is then a floor for that kind. */
    truncated: z.boolean().describe('True when a kind had more findings than are listed. `counts` is then a floor for that kind.'),
  })
  .strict();
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

export const RECONCILIATION_MAX_FINDINGS = 200;

/** A queued billing event the drain has failed to write. */
export const BillingOutboxStuckRowSchema = z
  .object({
    id: z.string(),
    applicationId: z.string().describe('The Application the queued event belongs to.'),
    /** The event type queued, when the payload still names one. */
    type: z.string().nullable().describe('The event type queued, when the payload still names one.'),
    attempts: z.number().int().describe('How many times the drain has tried to write it.'),
    lastError: z.string().nullable().describe('The last failure, when one was recorded.'),
    createdAt: z.string().datetime(),
    nextAttemptAt: z.string().datetime().describe('When the drain tries again.'),
  })
  .strict();

/** `GET /admin/metrics/billing-outbox`: what is waiting to reach the billing log, deployment-wide. */
export const BillingOutboxStatusSchema = z
  .object({
    /** Rows not yet in the log. */
    pending: z.number().int().describe('Rows not yet in the log.'),
    /** Of those, rows whose next attempt is due now. */
    due: z.number().int().describe('Of those, rows whose next attempt is due now.'),
    /** Of `pending`, rows that have failed `failingThreshold` times or more. */
    failing: z.number().int().describe('Of `pending`, rows that have failed `failingThreshold` times or more.'),
    failingThreshold: z.number().int().describe('The number of failed attempts from which a row counts as failing.'),
    oldestPendingAt: z.string().datetime().nullable().describe('When the oldest row still waiting was queued. Null when nothing waits.'),
    /** The failing rows, most attempts first, at most 100. */
    stuck: z.array(BillingOutboxStuckRowSchema).describe('The failing rows, most attempts first, at most 100.'),
  })
  .strict();
export type BillingOutboxStatus = z.infer<typeof BillingOutboxStatusSchema>;

/** Fallbacks to the default price for one plan, currency and country. */
export const PriceFallbackGroupSchema = z
  .object({
    planSlug: z.string().nullable().describe('The plan bought. Null when the plan no longer exists.'),
    /** The currency selected for the buyer, which no enabled provider could charge. */
    requestedCurrency: z.string().nullable().describe('The currency selected for the buyer, which no enabled provider could charge.'),
    /** The currency of the default price they were charged instead. */
    chargedCurrency: z.string().nullable().describe('The currency of the default price they were charged instead.'),
    /** The buyer's country. Null when it was not known, and for an erased buyer. */
    country: z.string().nullable().describe('The buyer\'s country. Null when it was not known, and for an erased buyer.'),
    count: z.number().int().describe('Checkouts in this group.'),
    lastOccurredAt: z.string().datetime().describe('When the most recent one happened.'),
  })
  .strict();

/**
 * `GET /tenant/applications/:id/billing/price-fallbacks`: how often a buyer
 * was charged the default price because their own currency could not be
 * charged, most frequent first.
 */
export const PriceFallbackSummarySchema = z
  .object({
    from: z.string().datetime().describe('Start of the period, inclusive.'),
    to: z.string().datetime().describe('End of the period, exclusive.'),
    /** Checkouts that fell back in the period, across the groups listed. */
    total: z.number().int().describe('Checkouts that fell back in the period, across the groups listed.'),
    /** At most 200 groups. */
    groups: z.array(PriceFallbackGroupSchema).describe('At most 200 groups.'),
  })
  .strict();
export type PriceFallbackSummary = z.infer<typeof PriceFallbackSummarySchema>;
