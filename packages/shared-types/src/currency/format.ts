/**
 * The one way Rekey writes an amount of money for a person to read.
 */

import { CURRENCY_TABLE } from './data.js';

/** Decimal places assumed for a code the table does not know. */
const UNKNOWN_CURRENCY_EXPONENT = 2;

function plain(amountMinor: number, exponent: number, code: string): string {
  return `${(amountMinor / 10 ** exponent).toFixed(exponent)} ${code}`;
}

/**
 * Format a stored minor-unit amount, such as "$19.99", "¥1,500" or
 * "₹1,499.00".
 *
 * The divisor is the registry's exponent, never the locale's: `Intl` shows the
 * forint and the Colombian peso with no decimals, and dividing by what it
 * shows would print a hundred times the price. Decimals the locale would hide
 * are kept whenever dropping them would round the amount.
 *
 * An unknown code never throws: it is written as a plain two-decimal number
 * followed by the code. An amount that is not a whole number of minor units
 * does throw: rounding it would print a price nobody was charged.
 *
 * @example
 * formatMoney(1999, 'USD');          // '$19.99'
 * formatMoney(1500, 'JPY');          // '¥1,500'
 * formatMoney(500000, 'HUF');        // 'HUF 5,000'
 * formatMoney(1999, 'EUR', 'de-DE'); // '19,99 €'
 * formatMoney(1234, 'ABC');          // '12.34 ABC'
 * formatMoney(19.5, 'USD');          // throws RangeError
 */
export function formatMoney(amountMinor: number, currency: string, locale = 'en-US'): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(
      `formatMoney takes a whole number of the smallest currency unit, and ${String(amountMinor)} is not one.`,
    );
  }
  const code = currency.trim().toUpperCase();
  const record = CURRENCY_TABLE[code];
  if (!record) return plain(amountMinor, UNKNOWN_CURRENCY_EXPONENT, code);

  const { exponent } = record;
  try {
    const shown = new Intl.NumberFormat(locale, { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits;
    const localeDigits = Math.min(shown ?? exponent, exponent);
    const exactAtLocaleDigits = amountMinor % 10 ** (exponent - localeDigits) === 0;
    const digits = exactAtLocaleDigits ? localeDigits : exponent;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amountMinor / 10 ** exponent);
  } catch {
    // A locale tag the runtime rejects must not turn a price into an exception.
    return plain(amountMinor, exponent, code);
  }
}
