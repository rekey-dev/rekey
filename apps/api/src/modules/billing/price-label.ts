/**
 * A price as a buyer reads it, for refusal messages.
 */

import { formatMoney } from '@rekey.dev/shared-types';

/**
 * "$99.00", "¥1,500" or "₹1,499.00", or null when there is no flat amount to
 * name.
 *
 * @example
 * priceLabel({ amount: 9900, currency: 'USD' }); // '$99.00'
 * priceLabel({ amount: 1500, currency: 'JPY' }); // '¥1,500'
 */
export function priceLabel(price: { amount: number | null; currency: string | null }): string | null {
  if (price.amount === null || price.amount === 0 || price.currency === null) return null;
  return formatMoney(price.amount, price.currency);
}
