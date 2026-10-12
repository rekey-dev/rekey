/**
 * What a subscription costs, as an operator is shown it.
 *
 * A subscription keeps the price its checkout, grant or import fixed. One with
 * none has no price: it is never shown its plan's, which may not be what the
 * buyer pays. The currency is returned as stored: upper-case it to compare.
 */

interface PricedSubscription {
  currency: string | null;
  unitAmount: number | null;
}

/**
 * The subscription's own price, or null when it has none.
 *
 * @example
 * subscriptionOwnPrice({ currency: 'INR', unitAmount: 149900 }); // { amount: 149900, currency: 'INR' }
 * subscriptionOwnPrice({ currency: null, unitAmount: null }); // null
 */
export function subscriptionOwnPrice(subscription: PricedSubscription): { amount: number; currency: string } | null {
  if (subscription.currency === null || subscription.unitAmount === null) return null;
  return { amount: subscription.unitAmount, currency: subscription.currency };
}
