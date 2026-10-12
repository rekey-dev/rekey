/**
 * How the billing log reads to an operator: a name and one line for every
 * event type, the sentence for one entry, and its typed `data` as labelled
 * values.
 *
 * `EVENT_COPY` is keyed by `BillingEventType`, and the two switches end in a
 * `never` check, so an event type added to the API without words here does
 * not compile.
 */

import type { BillingEventType, BillingLogEntry } from '@rekey.dev/shared-types';
import { UNAVAILABLE_CURRENCY, type UnavailableCurrencyRule } from './billing-config';
import { formatDateTime } from './date';
import { formatMoney } from './format';

/** What a log filter groups by. Configuration is hidden until asked for. */
export type EventGroup = 'money' | 'refusal' | 'configuration' | 'diagnostic';

export interface EventCopy {
  /** The event's name, for filters and headings. */
  title: string;
  /** One line on what it records. */
  description: string;
  group: EventGroup;
}

export const EVENT_COPY = {
  'checkout.opened': {
    title: 'Checkout opened',
    description: 'A buyer was sent to pay, with the price shown and the price that will be charged.',
    group: 'diagnostic',
  },
  'checkout.price_fallback': {
    title: 'Default price used',
    description: 'No enabled provider could charge the price selected for the buyer, so the default price is charged instead.',
    group: 'money',
  },
  'checkout.refused': {
    title: 'Checkout refused',
    description: 'A checkout was not opened, with the reason the caller was given.',
    group: 'refusal',
  },
  'checkout.completed': {
    title: 'Checkout completed',
    description: 'The provider confirmed a checkout was paid.',
    group: 'money',
  },
  'checkout.expired': {
    title: 'Checkout ended unpaid',
    description: 'A checkout timed out, its payment failed, or it was opened in the wrong mode.',
    group: 'diagnostic',
  },
  'payment.recorded': {
    title: 'Payment recorded',
    description: 'A charge was written as a payment, verified against a price or held as unverified.',
    group: 'money',
  },
  'payment.failed': {
    title: 'Payment failed',
    description: 'The provider reported a charge that did not go through.',
    group: 'money',
  },
  'payment.not_applied': {
    title: 'Payment not applied',
    description: 'A charge did not match what the subscription pays, so nothing was granted for it and it is held as unverified.',
    group: 'refusal',
  },
  'payment.refunded': {
    title: 'Payment refunded',
    description: 'Money went back to the buyer, in full or in part.',
    group: 'money',
  },
  'payment.unapplied': {
    title: 'Unapplied payment opened',
    description: 'A payment that could not be matched to anything was put in front of an operator.',
    group: 'money',
  },
  'payment.unapplied_resolved': {
    title: 'Unapplied payment resolved',
    description: 'An operator refunded an unapplied payment, granted for it, or dismissed it.',
    group: 'money',
  },
  'payment.not_recorded': {
    title: 'Provider report not recorded',
    description: 'A provider reported money moving and Rekey could not store it as a payment or a refund. The money is at the provider.',
    group: 'refusal',
  },
  'subscription.activated': {
    title: 'Subscription started',
    description: 'A subscription became active, by checkout, grant, import or a provider event.',
    group: 'money',
  },
  'subscription.canceled': {
    title: 'Subscription canceled',
    description: 'A subscription was canceled, now or at the end of its period.',
    group: 'money',
  },
  'subscription.granted': {
    title: 'Subscription granted',
    description: 'An operator granted a subscription with no payment behind it.',
    group: 'money',
  },
  'subscription.imported': {
    title: 'Subscription imported',
    description: 'A subscription was brought in from another billing system.',
    group: 'money',
  },
  'subscription.priced': {
    title: 'Subscription price set',
    description: 'The price a subscription is on was recorded or changed, with what set it.',
    group: 'money',
  },
  'coupon.redeemed': {
    title: 'Coupon redeemed',
    description: 'A coupon took an amount off a paid checkout.',
    group: 'money',
  },
  'coupon.refused': {
    title: 'Coupon refused',
    description: 'A known coupon could not be used, with the reason the buyer was given.',
    group: 'refusal',
  },
  'coupon.created': {
    title: 'Coupon created',
    description: 'A coupon was created, with its terms.',
    group: 'configuration',
  },
  'coupon.changed': {
    title: 'Coupon changed',
    description: 'A coupon was switched on or off, or its terms, expiry or redemption limits changed, with each before and after.',
    group: 'configuration',
  },
  'credits.granted': {
    title: 'Credits granted',
    description: 'Credits were added to a balance by a purchase, a refill, a plan or an operator.',
    group: 'money',
  },
  'plan.price_set': {
    title: 'Price set',
    description: 'A plan price was added, or its amount or countries changed.',
    group: 'configuration',
  },
  'plan.price_archived': {
    title: 'Price removed',
    description: 'A plan price was taken off sale: archived when records still name it, deleted otherwise.',
    group: 'configuration',
  },
  'plan.local_prices_changed': {
    title: 'Plan local prices changed',
    description: 'Whether a buyer’s country may select this plan’s other prices was changed.',
    group: 'configuration',
  },
  'provider.currencies_changed': {
    title: 'Provider currencies changed',
    description: 'The currencies a provider account is sent were changed.',
    group: 'configuration',
  },
  'settings.local_prices_changed': {
    title: 'Local prices setting changed',
    description: 'Whose word about a buyer’s country may select a local price was changed.',
    group: 'configuration',
  },
  'settings.unavailable_currency_changed': {
    title: 'Rule for a currency that cannot be charged changed',
    description: 'What a checkout does when your server names a currency no provider can charge was changed.',
    group: 'configuration',
  },
  'settings.reporting_currency_changed': {
    title: 'Reporting currency changed',
    description: 'The currency this Application’s figures lead with was changed. Nothing was converted.',
    group: 'configuration',
  },
  'diagnostic.aggregated': {
    title: 'Events counted, not listed',
    description: 'Past a threshold per hour, events of one kind and reason are counted in one entry.',
    group: 'diagnostic',
  },
  'reconciliation.finding': {
    title: 'Reconciliation finding',
    description: 'The hourly comparison found the log and the money records disagreeing.',
    group: 'diagnostic',
  },
} as const satisfies Record<BillingEventType, EventCopy>;

export const EVENT_GROUP_LABEL: Record<EventGroup, string> = {
  money: 'Money',
  refusal: 'Refusals',
  configuration: 'Configuration',
  diagnostic: 'Diagnostics',
};

/** The event types of the groups named, in the order `EVENT_COPY` lists them. */
export function typesInGroups(groups: readonly EventGroup[]): BillingEventType[] {
  return (Object.keys(EVENT_COPY) as BillingEventType[]).filter((type) => groups.includes(EVENT_COPY[type].group));
}

/** Money as written, or the bare number when the currency is not one Rekey can format. */
export function eventMoney(amount: number | null, currency: string | null): string | null {
  if (amount === null) return null;
  if (currency === null) return String(amount);
  try {
    return formatMoney(amount, currency);
  } catch {
    return `${amount} ${currency}`;
  }
}

interface PriceLike {
  currency: string;
  amount: number;
}

function price(value: PriceLike | null): string {
  return value === null ? 'none' : (eventMoney(value.amount, value.currency) ?? 'none');
}

const NOT_APPLIED_REASON: Record<string, string> = {
  currency_mismatch: 'it was in another currency than the subscription pays in',
  amount_out_of_band: 'the amount was far from the subscription’s price',
  price_not_on_plan: 'the provider price belongs to no price of the plan',
  no_subscription: 'no subscription could be found for it',
  duplicate_completion: 'the checkout had already been completed',
};

const NOT_RECORDED_REASON: Record<string, string> = {
  amount_not_storable: 'the amount is not one a payment can hold',
  payment_unknown: 'it names a payment that is not on record',
  payment_not_refundable: 'the payment cannot take a refund',
  currency_mismatch: 'it is in another currency than the payment',
  exceeds_payment: 'it is more than the payment',
};

const UNAVAILABLE_SENTENCE: Record<UnavailableCurrencyRule, string> = {
  refuse: 'A checkout that names a currency nobody can charge is now refused',
  fallback: 'A checkout that names a currency nobody can charge now pays the default price',
};

const FINDING_WORDS: Record<string, string> = {
  payment_without_event: 'a payment has no log entry',
  event_without_payment: 'a log entry names a payment that does not exist',
  refund_mismatch: 'a payment’s refunds add up differently in the payment, the refund records and the log',
  subscription_without_event: 'a subscription has no activation entry',
};

const EXPIRED_REASON: Record<string, string> = {
  timed_out: 'it timed out',
  payment_failed: 'its payment failed',
  mode_mismatch: 'it was opened in another mode than the provider is in now',
};

function words(map: Record<string, string>, key: string): string {
  return Object.hasOwn(map, key) ? (map[key] as string) : key.replaceAll('_', ' ');
}

function unhandled(entry: never): string {
  return (entry as { type: string }).type;
}

/**
 * One entry as a sentence an operator can read without knowing the event
 * type's name.
 *
 * @example
 * eventSentence(fallbackEntry); // 'Charged $19.00 because INR could not be charged'
 */
export function eventSentence(entry: BillingLogEntry): string {
  const amount = eventMoney(entry.amount, entry.currency);
  switch (entry.type) {
    case 'checkout.opened':
      return `Checkout opened for ${entry.data.planSlug} at ${price(entry.data.priceCharged)}`;
    case 'checkout.price_fallback':
      return `Charged ${price(entry.data.charged)} because ${entry.data.requested.currency} could not be charged`;
    case 'checkout.refused':
      return `Checkout refused${entry.data.planSlug ? ` for ${entry.data.planSlug}` : ''}: ${entry.data.code}`;
    case 'checkout.completed':
      return `Checkout completed for ${entry.data.planSlug} at ${price(entry.data.priceCharged)}`;
    case 'checkout.expired':
      return `Checkout ended unpaid because ${words(EXPIRED_REASON, entry.data.reason)}`;
    case 'payment.recorded':
      return entry.data.verification === 'verified'
        ? `Payment of ${amount ?? 'an unknown amount'} recorded`
        : `Payment of ${amount ?? 'an unknown amount'} recorded as unverified`;
    case 'payment.failed':
      return `Payment${amount ? ` of ${amount}` : ''} failed`;
    case 'payment.not_applied':
      return `Payment${amount ? ` of ${amount}` : ''} was not applied because ${words(NOT_APPLIED_REASON, entry.data.reason)}`;
    case 'payment.refunded':
      return `Refunded ${eventMoney(entry.data.refundedAmount, entry.currency) ?? 'an amount'}`;
    case 'payment.unapplied':
      return `Payment${amount ? ` of ${amount}` : ''} could not be applied and needs a decision`;
    case 'payment.unapplied_resolved':
      return `Unapplied payment ${words({ entitlement_granted: 'applied to a subscription' }, entry.data.resolution)}`;
    case 'payment.not_recorded':
      return `A provider reported a ${entry.data.kind.replace('_', ' ')} that was not recorded because ${words(NOT_RECORDED_REASON, entry.data.reason)}`;
    case 'subscription.activated':
      return `Subscription to ${entry.data.planSlug} started${entry.data.trial ? ' in a trial' : ''}`;
    case 'subscription.canceled':
      return `Subscription to ${entry.data.planSlug} canceled${entry.data.atPeriodEnd ? ' at the end of its period' : ''}`;
    case 'subscription.granted':
      return `Subscription to ${entry.data.planSlug} granted`;
    case 'subscription.imported':
      return `Subscription to ${entry.data.planSlug} imported`;
    case 'subscription.priced':
      return entry.data.before === null
        ? `Subscription to ${entry.data.planSlug} priced at ${price(entry.data.after)}`
        : `Subscription price changed from ${price(entry.data.before)} to ${price(entry.data.after)}`;
    case 'coupon.redeemed':
      return `Coupon ${entry.data.code} took ${eventMoney(entry.data.discountAmount, entry.data.priceCharged.currency) ?? 'an amount'} off ${entry.data.planSlug}`;
    case 'coupon.refused':
      return `Coupon ${entry.data.code} refused: ${entry.data.reasonCode}`;
    case 'coupon.created':
      return `Coupon ${entry.data.code} created`;
    case 'coupon.changed':
      return entry.data.before.active !== entry.data.after.active
        ? `Coupon ${entry.data.code} switched ${entry.data.after.active ? 'on' : 'off'}`
        : `Coupon ${entry.data.code} changed`;
    case 'credits.granted':
      return `${entry.data.credits} credits granted`;
    case 'plan.price_set': {
      const currency = entry.currency;
      const after = eventMoney(entry.data.after.amount, currency) ?? String(entry.data.after.amount);
      if (entry.data.before === null) return `${currency ?? 'A'} price of ${after} added to ${entry.data.planSlug}`;
      if (entry.data.before.amount !== entry.data.after.amount) {
        return `Price of ${entry.data.planSlug} changed from ${eventMoney(entry.data.before.amount, currency) ?? entry.data.before.amount} to ${after}`;
      }
      return `Countries changed for the ${currency === null ? '' : `${currency} `}price of ${entry.data.planSlug}`;
    }
    case 'plan.price_archived':
      return `${entry.currency ?? 'A'} price of ${entry.data.planSlug} ${entry.data.outcome}`;
    case 'plan.local_prices_changed':
      return `Local prices on ${entry.data.planSlug} changed from ${entry.data.before} to ${entry.data.after}`;
    case 'provider.currencies_changed':
      return `${entry.provider ?? 'A provider'} now takes ${entry.data.after.length === 0 ? 'no currency' : entry.data.after.join(', ')}`;
    case 'settings.local_prices_changed':
      return `Local prices setting changed from ${entry.data.before} to ${entry.data.after}`;
    case 'settings.unavailable_currency_changed':
      return UNAVAILABLE_SENTENCE[entry.data.after];
    case 'settings.reporting_currency_changed':
      return `Reporting currency changed${entry.data.before ? ` from ${entry.data.before}` : ''} to ${entry.data.after}`;
    case 'diagnostic.aggregated':
      return `${entry.data.suppressed} more ${EVENT_COPY[entry.data.eventType].title.toLowerCase()} entries (${entry.data.reason}) counted and not listed`;
    case 'reconciliation.finding':
      return `Reconciliation found that ${words(FINDING_WORDS, entry.data.kind)}`;
    default:
      return unhandled(entry);
  }
}

export interface EventField {
  label: string;
  value: string;
}

function field(label: string, value: string | number | boolean | null | undefined): EventField[] {
  if (value === null || value === undefined || value === '') return [];
  return [{ label, value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value) }];
}

const COUNTRY_SOURCE: Record<string, string> = {
  declared: 'passed by your server',
  vouched: 'vouched for by a trusted proxy',
  hint: 'stated by the buyer’s browser',
};

function country(data: { buyerCountry: string | null; buyerCountrySource: string | null }): EventField[] {
  if (data.buyerCountry === null) return [];
  const source = data.buyerCountrySource === null ? '' : `, ${words(COUNTRY_SOURCE, data.buyerCountrySource)}`;
  return [{ label: 'Buyer country', value: `${data.buyerCountry}${source}` }];
}

const PRICE_REASON: Record<string, string> = {
  bound: 'the buyer already pays in this currency',
  requested: 'your server named the currency',
  country: 'it is the price for the buyer’s country',
  default: 'no other price applied',
  fallback: 'the price selected first could not be charged',
};

interface TermsLike {
  active: boolean;
  basisPoints: number | null;
  amounts: ReadonlyArray<{ currency: string; amountOff: number }>;
  currencies: readonly string[];
  planSlugs: readonly string[];
  /** The three below are absent on entries written before they were logged. */
  endsAt?: string | null | undefined;
  maxRedemptions?: number | null | undefined;
  maxRedemptionsPerUser?: number | null | undefined;
}

function termLimits(value: TermsLike): string {
  const parts = [
    value.endsAt === undefined ? null : value.endsAt === null ? 'never expires' : `expires ${formatDateTime(value.endsAt)} UTC`,
    value.maxRedemptions === undefined
      ? null
      : value.maxRedemptions === null
        ? 'no redemption limit'
        : `at most ${value.maxRedemptions} redemptions`,
    value.maxRedemptionsPerUser === undefined
      ? null
      : value.maxRedemptionsPerUser === null
        ? 'no limit per buyer'
        : `at most ${value.maxRedemptionsPerUser} per buyer`,
  ].filter((part): part is string => part !== null);
  return parts.map((part) => `; ${part}`).join('');
}

function terms(label: string, value: TermsLike): EventField[] {
  const discount =
    value.basisPoints !== null
      ? `${value.basisPoints / 100}% off`
      : value.amounts.map((amount) => eventMoney(amount.amountOff, amount.currency)).join(', ') || 'no amount';
  const where = value.basisPoints === null ? '' : value.currencies.length === 0 ? ', any currency' : `, in ${value.currencies.join(', ')}`;
  const plans = value.planSlugs.length === 0 ? 'every plan' : value.planSlugs.join(', ');
  return [{ label, value: `${discount}${where}; ${plans}; ${value.active ? 'active' : 'inactive'}${termLimits(value)}` }];
}

function countries(list: readonly string[]): string {
  return list.length === 0 ? 'wherever the currency is local' : list.join(', ');
}

/**
 * An entry's `data` as labelled values, for the detail view. Amounts are
 * written as money, reasons as words, and nothing here is a raw key.
 *
 * @example
 * eventFields(fallbackEntry);
 * // [{ label: 'Plan', value: 'pro' }, { label: 'Price selected', value: '₹1,499.00' }, ...]
 */
export function eventFields(entry: BillingLogEntry): EventField[] {
  switch (entry.type) {
    case 'checkout.opened':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Price shown', price(entry.data.priceShown)),
        ...field('Price charged', price(entry.data.priceCharged)),
        ...field('Why this price', words(PRICE_REASON, entry.data.reason)),
        ...field('Discount', eventMoney(entry.data.discountAmount, entry.data.priceCharged.currency)),
        ...country(entry.data),
      ];
    case 'checkout.price_fallback':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Price selected', price(entry.data.requested)),
        ...field('Price charged', price(entry.data.charged)),
        ...field('Why', `no enabled provider can charge ${entry.data.requested.currency}`),
        ...country(entry.data),
      ];
    case 'checkout.refused':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Refusal', entry.data.code),
        ...field('Currency asked for', entry.data.requestedCurrency),
        ...country(entry.data),
      ];
    case 'checkout.completed':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Price charged', price(entry.data.priceCharged)),
        ...field('Discount', eventMoney(entry.data.discountAmount, entry.data.priceCharged.currency)),
        ...field('Provider session', entry.data.providerSessionId),
      ];
    case 'checkout.expired':
      return [...field('Plan', entry.data.planSlug), ...field('Why', words(EXPIRED_REASON, entry.data.reason))];
    case 'payment.recorded':
      return [
        ...field('Verification', entry.data.verification === 'verified' ? 'Verified against the price' : 'Unverified: held, not counted as revenue'),
        ...field('Price it was for', entry.data.priceCharged === null ? null : price(entry.data.priceCharged)),
        ...field('Discount', eventMoney(entry.data.discountAmount, entry.currency)),
        ...field('Provider payment', entry.data.providerPaymentId),
      ];
    case 'payment.failed':
      return [...field('Provider payment', entry.data.providerPaymentId), ...field('Failure', entry.data.failureCode)];
    case 'payment.not_applied':
      return [
        ...field('Why', words(NOT_APPLIED_REASON, entry.data.reason)),
        ...field('Price expected', entry.data.expected === null ? null : price(entry.data.expected)),
        ...field('Provider payment', entry.data.providerPaymentId),
      ];
    case 'payment.refunded':
      return [
        ...field('Refunded now', eventMoney(entry.data.refundedAmount, entry.currency)),
        ...field('Refunded in total', eventMoney(entry.data.totalRefunded, entry.currency)),
        ...field('Started by', entry.data.initiatedBy),
        ...field('Reason', entry.data.reasonCode),
        ...field('Provider refund', entry.data.providerRefundId),
      ];
    case 'payment.unapplied':
      return [...field('Case', entry.data.unappliedPaymentId), ...field('Why', entry.data.reasonCode)];
    case 'payment.unapplied_resolved':
      return [
        ...field('Case', entry.data.unappliedPaymentId),
        ...field('Outcome', words({ entitlement_granted: 'applied to a subscription, which verifies the payment' }, entry.data.resolution)),
      ];
    case 'payment.not_recorded':
      return [
        ...field('What was reported', entry.data.kind.replace('_', ' ')),
        ...field('Why it was not recorded', words(NOT_RECORDED_REASON, entry.data.reason)),
        ...field('Amount reported', entry.data.reportedAmount),
        ...field('Provider payment', entry.data.providerPaymentId),
        ...field('Provider refund', entry.data.providerRefundId),
      ];
    case 'subscription.activated':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Price', entry.data.price === null ? 'none recorded' : price(entry.data.price)),
        ...field('Started by', entry.data.via),
        ...field('Trial', entry.data.trial),
      ];
    case 'subscription.canceled':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('When', entry.data.atPeriodEnd ? 'At the end of the period' : 'Immediately'),
        ...field('Canceled by', entry.data.cause.replace('_', ' ')),
      ];
    case 'subscription.granted':
      return [...field('Plan', entry.data.planSlug), ...field('Price', entry.data.price === null ? 'none recorded' : price(entry.data.price))];
    case 'subscription.imported':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Price', entry.data.price === null ? 'none recorded' : price(entry.data.price)),
        ...field('Import run', entry.data.importRunId),
      ];
    case 'subscription.priced':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Before', entry.data.before === null ? 'no price' : price(entry.data.before)),
        ...field('After', price(entry.data.after)),
        ...field('Set by', entry.data.cause.replace('_', ' ')),
      ];
    case 'coupon.redeemed':
      return [
        ...field('Coupon', entry.data.code),
        ...field('Plan', entry.data.planSlug),
        ...field('Taken off', eventMoney(entry.data.discountAmount, entry.data.priceCharged.currency)),
        ...field('Price before the discount', price(entry.data.priceCharged)),
      ];
    case 'coupon.refused':
      return [
        ...field('Coupon', entry.data.code),
        ...field('Plan', entry.data.planSlug),
        ...field('Refusal', entry.data.reasonCode),
        ...field('Currency charged', entry.data.chargedCurrency),
      ];
    case 'coupon.created':
      return [...field('Coupon', entry.data.code), ...terms('Terms', entry.data.terms)];
    case 'coupon.changed':
      return [...field('Coupon', entry.data.code), ...terms('Before', entry.data.before), ...terms('After', entry.data.after)];
    case 'credits.granted':
      return [
        ...field('Credits', entry.data.credits),
        ...field('From', entry.data.source),
        ...field('Balance after', entry.data.balanceAfter),
      ];
    case 'plan.price_set':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Default price', entry.data.isDefault),
        ...field(
          'Before',
          entry.data.before === null
            ? 'no price in this currency'
            : `${eventMoney(entry.data.before.amount, entry.currency)}, ${countries(entry.data.before.countries)}`,
        ),
        ...field('After', `${eventMoney(entry.data.after.amount, entry.currency)}, ${countries(entry.data.after.countries)}`),
      ];
    case 'plan.price_archived':
      return [
        ...field('Plan', entry.data.planSlug),
        ...field('Price', eventMoney(entry.data.amount, entry.currency)),
        ...field('Outcome', entry.data.outcome === 'archived' ? 'Archived: records still name it' : 'Deleted: nothing named it'),
      ];
    case 'plan.local_prices_changed':
      return [...field('Plan', entry.data.planSlug), ...field('Before', entry.data.before), ...field('After', entry.data.after)];
    case 'provider.currencies_changed':
      return [
        ...field('Before', entry.data.before.length === 0 ? 'no currency' : entry.data.before.join(', ')),
        ...field('After', entry.data.after.length === 0 ? 'no currency' : entry.data.after.join(', ')),
      ];
    case 'settings.local_prices_changed':
      return [...field('Before', entry.data.before), ...field('After', entry.data.after)];
    case 'settings.unavailable_currency_changed':
      return [
        ...field('Before', UNAVAILABLE_CURRENCY[entry.data.before].label),
        ...field('After', UNAVAILABLE_CURRENCY[entry.data.after].label),
      ];
    case 'settings.reporting_currency_changed':
      return [...field('Before', entry.data.before ?? 'not set'), ...field('After', entry.data.after)];
    case 'diagnostic.aggregated':
      return [
        ...field('Event', EVENT_COPY[entry.data.eventType].title),
        ...field('Reason', entry.data.reason),
        ...field('Hour starting', entry.data.windowStart),
        ...field('Not listed', entry.data.suppressed),
      ];
    case 'reconciliation.finding':
      return [
        ...field('Finding', words(FINDING_WORDS, entry.data.kind)),
        ...field('Refunded on the payment', eventMoney(entry.data.refundedOnPayment, entry.currency)),
        ...field('Refund records add up to', eventMoney(entry.data.refundRowsTotal, entry.currency)),
        ...field('Refund entries in the log add up to', eventMoney(entry.data.refundEventsTotal, entry.currency)),
      ];
    default:
      return [{ label: 'Event', value: unhandled(entry) }];
  }
}

const ACTOR_LABEL: Record<BillingLogEntry['actor']['type'], string> = {
  system: 'Rekey',
  operator: 'Operator',
  end_user: 'End user',
  provider: 'Provider',
};

/** Who caused an entry, in a word. */
export function actorLabel(actor: BillingLogEntry['actor']): string {
  return ACTOR_LABEL[actor.type];
}

/** What reconciliation can find, with what each finding means and what to do about it. */
export const FINDING_COPY: Record<
  'payment_without_event' | 'event_without_payment' | 'refund_mismatch' | 'subscription_without_event',
  { title: string; meaning: string }
> = {
  payment_without_event: {
    title: 'Payment with no log entry',
    meaning:
      'A payment is on record and the log has no entry for it. The payment itself is intact. An entry that is still queued shows up here until it is written, so look again in a few minutes before treating it as lost.',
  },
  event_without_payment: {
    title: 'Log entry with no payment',
    meaning:
      'A log entry names a payment that is not on record. Check the provider for the charge: if the money was taken, the payment was not stored.',
  },
  refund_mismatch: {
    title: 'Refund totals disagree',
    meaning:
      'The refunded total on the payment, the refund records and the refund entries in the log do not add up to the same amount. Compare the three figures with the provider before refunding this payment again.',
  },
  subscription_without_event: {
    title: 'Subscription with no start entry',
    meaning:
      'A subscription exists and the log has no entry for it starting. The subscription itself is intact. Its history in the log begins later than it did.',
  },
};
