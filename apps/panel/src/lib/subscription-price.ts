/**
 * What a subscriber pays, as the end-user pages write it.
 *
 * Read from the subscription's own `price`, never from the plan: a plan with
 * prices in several currencies has subscribers on each, and the plan's own
 * amount is only its default.
 */

import { formatMoney } from './format';

/**
/** Shown for a subscription with no price of its own. Never 0, and never the plan's price. */
export const NO_PRICE_RECORDED = 'No price recorded';

/**
 * @example
 * subscriptionPriceLabel({ price: { amount: 149900, currency: 'INR' }, plan: { interval: 'MONTH' } }); // '₹1,499.00 / month'
 * subscriptionPriceLabel({ price: null, plan: { interval: 'MONTH' } }); // 'No price recorded'
 */
export function subscriptionPriceLabel(subscription: {
  price: { amount: number; currency: string } | null;
  plan: { interval: string | null };
}): string {
  if (subscription.price === null) return NO_PRICE_RECORDED;
  const price = formatMoney(subscription.price.amount, subscription.price.currency);
  const interval = subscription.plan.interval;
  return interval ? `${price} / ${interval.toLowerCase()}` : price;
}
