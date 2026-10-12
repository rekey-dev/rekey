/**
 * Money rendering for the hosted portal: what a plan costs this buyer, what a
 * subscription charges, and one formatter for the amounts the API sends
 * without a written form (payments).
 *
 * A plan's price is the API's resolved `price`: the one this buyer's checkout
 * would charge, already written for a person. Nothing here picks between a
 * plan's prices or reads its default.
 */

import { formatMoney as formatRegistryMoney } from '@rekey.dev/shared-types/currency';

/**
 * A stored minor-unit amount as a price, such as '$9.99' or '¥1,000'. Throws
 * a RangeError for an amount that is not a whole number.
 */
export function formatMoney(amount: number, currency: string): string {
  return formatRegistryMoney(amount, currency);
}

/** The subset of a catalogue plan this module reads. */
export interface PricePlan {
  /** Whether the plan charges nothing at all. */
  isFree: boolean;
  /** The price this buyer would be charged, or null for a plan with no flat price. */
  price: { formatted: string } | null;
  /** SUBSCRIPTION / LICENSE / USAGE / CREDIT. */
  kind?: string;
  /** Billing interval, only meaningful for SUBSCRIPTION plans. */
  interval?: string | null;
  /** Credits granted, for CREDIT-kind plans. */
  creditsAmount?: number | null;
}

/** "/month" for a subscription, nothing for a one-off: `Plan.interval` defaults to MONTH whatever the kind. */
function cadence(plan: Pick<PricePlan, 'kind' | 'interval'>): string {
  return plan.kind === 'SUBSCRIPTION' && plan.interval ? ` /${plan.interval.toLowerCase()}` : '';
}

/**
 * The price this buyer would be charged, plus the one qualifier that applies.
 *
 * A plan with no flat price that is not free is metered: calling it "Free"
 * would promise a bill of nothing.
 *
 * @example
 * formatPlanPrice({ isFree: false, price: { formatted: '₹1,499.00' }, kind: 'SUBSCRIPTION', interval: 'MONTH' });
 * // '₹1,499.00 /month'
 */
export function formatPlanPrice(plan: PricePlan): string {
  if (plan.isFree) return 'Free';
  if (plan.price === null) return 'Billed by usage';
  if (plan.kind === 'CREDIT' && plan.creditsAmount) {
    return `${plan.price.formatted} · ${plan.creditsAmount} credits`;
  }
  return `${plan.price.formatted}${cadence(plan)}`;
}

/**
 * What a subscriber pays each period: the price their own checkout fixed,
 * which can differ from the plan's price today. Null when the subscription
 * records none (a free plan, or a checkout not paid yet).
 *
 * @example
 * subscriptionPriceLabel({ formatted: '$19.00' }, { kind: 'SUBSCRIPTION', interval: 'YEAR' }); // '$19.00 /year'
 */
export function subscriptionPriceLabel(
  price: { formatted: string } | null,
  plan: Pick<PricePlan, 'kind' | 'interval'> | undefined,
): string | null {
  if (price === null) return null;
  return `${price.formatted}${plan ? cadence(plan) : ''}`;
}

/** The part of a payment row the refund line reads. */
export interface RefundablePayment {
  amount: number;
  currency: string;
  /** The sum of the payment's refunds that have not failed. 0 when nothing was refunded. */
  refundedAmount: number;
}

/**
 * What to say about money returned on a payment, in the payment's own
 * currency, or null when nothing was.
 *
 * @example
 * refundLine({ amount: 1900, currency: 'USD', refundedAmount: 500 }); // 'Refunded $5.00 of $19.00'
 */
export function refundLine(payment: RefundablePayment): string | null {
  const returned = payment.refundedAmount;
  if (returned <= 0) return null;
  const refunded = formatMoney(returned, payment.currency);
  if (returned >= payment.amount) return `Refunded ${refunded}`;
  return `Refunded ${refunded} of ${formatMoney(payment.amount, payment.currency)}`;
}
