/**
 * What every price a plan sells at must satisfy, its default price included:
 * a currency a buyer can pay in, and an amount that currency can express.
 */

import { currencySellability, validatePriceAmount } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';

/**
 * The currency upper-cased, or a refusal for one a price cannot be in.
 *
 * @example
 * priceCurrency('inr'); // 'INR'
 * priceCurrency('KWD'); // throws PLAN_PRICE_CURRENCY_UNSUPPORTED
 */
export function priceCurrency(raw: string): string {
  const currency = raw.trim().toUpperCase();
  const sellability = currencySellability(currency);
  if (sellability.sellable) return currency;
  if (sellability.reason === 'unknown') {
    throw new RekeyError({
      statusCode: 400,
      code: 'PLAN_PRICE_CURRENCY_INVALID',
      message: `"${raw}" is not an ISO 4217 currency code.`,
      fix: 'Use a three-letter ISO 4217 code such as INR, EUR or GBP.',
    });
  }
  throw new RekeyError({
    statusCode: 400,
    code: 'PLAN_PRICE_CURRENCY_UNSUPPORTED',
    message:
      sellability.reason === 'three_decimal'
        ? `${currency} has three decimal places, and a price in it cannot be charged as written: Stripe and Razorpay accept only amounts ending in 0, and PayPal does not take it.`
        : `${currency} is not a currency a buyer can pay in.`,
    fix: 'Price the plan in a currency with two decimals or none, such as USD, EUR, INR or JPY.',
  });
}

/**
 * Refuse an amount a price in `currency` cannot have. `currency` is one
 * `priceCurrency` returned.
 *
 * @example
 * assertPriceAmount('HUF', 150); // throws PLAN_PRICE_AMOUNT_INVALID: the forint is priced in whole units
 */
export function assertPriceAmount(currency: string, amount: number): void {
  const checked = validatePriceAmount(currency, amount);
  if (checked.ok) return;
  if (checked.rule === 'not_whole_unit') {
    throw new RekeyError({
      statusCode: 400,
      code: 'PLAN_PRICE_AMOUNT_INVALID',
      message: `${currency} is priced in whole units, so ${amount} cannot be charged: the amount must end in 00.`,
      fix: `Send the amount in hundredths with no fraction, such as 500000 for 5,000 ${currency}.`,
    });
  }
  if (checked.rule === 'too_large') {
    throw new RekeyError({
      statusCode: 400,
      code: 'PLAN_PRICE_AMOUNT_INVALID',
      message: checked.message,
      fix: 'Send a smaller amount. Amounts are in minor units (paise, cents, pence), so 1999 is 19.99.',
    });
  }
  throw new RekeyError({
    statusCode: 400,
    code: 'PLAN_PRICE_AMOUNT_INVALID',
    message: `A price must be a whole number of the currency's smallest unit, greater than 0, not ${amount}.`,
    fix: 'Send the amount in minor units (paise, cents, pence), never as a decimal. A currency with no decimals, such as JPY, takes the whole amount.',
  });
}
