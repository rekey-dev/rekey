/**
 * PayPal's wire scale: the conversion between a stored amount (an integer at
 * the ISO 4217 exponent) and the decimal string PayPal's API takes and
 * reports in `amount.value`.
 *
 * The scale is PayPal's own and belongs beside the code that talks to PayPal:
 * providers disagree with ISO and with each other, so one shared table would
 * be wrong for somebody.
 */

import { minorUnitExponent } from '@rekey.dev/shared-types';
import { amountNotChargeable, unknownCurrencyScale } from './amount-not-chargeable.js';

/**
 * Currencies PayPal takes without a decimal point: "This currency does not
 * support decimals. If you pass a decimal amount, an error occurs."
 * https://developer.paypal.com/api/rest/reference/currency-codes/
 *
 * JPY has no minor unit in ISO either. HUF and TWD have two places there, so
 * a stored HUF 500000 (5000 Ft) is sent as "5000", and a stored amount that
 * does not end in 00 cannot be sent at all.
 */
export const PAYPAL_NO_DECIMALS: ReadonlySet<string> = new Set(['HUF', 'JPY', 'TWD']);

/**
 * Every currency PayPal's REST APIs take, from the same page.
 * https://developer.paypal.com/api/rest/reference/currency-codes/
 */
export const PAYPAL_SUPPORTED_CURRENCIES: readonly string[] = [
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'JPY',
  'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RUB', 'SEK', 'SGD', 'THB', 'TWD', 'USD',
];

/**
 * "Supported as a payment currency and a currency balance for in-country
 * PayPal accounts only": an account outside Brazil, China or Malaysia cannot
 * charge these.
 */
export const PAYPAL_IN_COUNTRY_ONLY: ReadonlySet<string> = new Set(['BRL', 'CNY', 'MYR']);

const WIRE_FORMAT = /^\d+(?:\.(\d+))?$/;

function normalise(currency: string | null | undefined): string {
  return (currency ?? '').trim().toUpperCase();
}

function wireDecimals(code: string): 0 | 2 {
  return PAYPAL_NO_DECIMALS.has(code) ? 0 : 2;
}

/**
 * A stored amount as the decimal string PayPal takes for that currency.
 * Refuses, never rounds, an amount PayPal cannot take exactly.
 *
 * @example
 * toProviderAmount('USD', 1999);   // '19.99'
 * toProviderAmount('JPY', 5000);   // '5000'
 * toProviderAmount('HUF', 500000); // '5000': stored HUF is in ISO minor units
 * toProviderAmount('HUF', 500050); // throws BILLING_AMOUNT_NOT_CHARGEABLE
 */
export function toProviderAmount(currency: string, amountMinor: number): string {
  const code = normalise(currency);
  const iso = minorUnitExponent(code);
  if (iso === null) throw unknownCurrencyScale('PayPal', code);
  if (iso === 3) {
    throw amountNotChargeable(
      'PayPal',
      code,
      `${code} has three decimal places and PayPal takes at most two.`,
      'Charge this price through another provider, or price it in a currency PayPal supports.',
    );
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw amountNotChargeable(
      'PayPal',
      code,
      `${String(amountMinor)} is not a whole, non-negative number of the smallest ${code} unit.`,
      `Send the amount as a non-negative integer in the smallest ${code} unit.`,
    );
  }
  const unitSize = 10 ** iso;
  const whole = Math.floor(amountMinor / unitSize);
  const fraction = amountMinor % unitSize;
  if (wireDecimals(code) === 0) {
    if (fraction !== 0) {
      throw amountNotChargeable(
        'PayPal',
        code,
        `PayPal takes ${code} in whole units, and ${amountMinor} is not a whole number of them.`,
        `Use a ${code} amount that ends in 00.`,
      );
    }
    return String(whole);
  }
  return `${whole}.${iso === 0 ? '00' : String(fraction).padStart(2, '0')}`;
}

/**
 * The stored amount for a PayPal decimal string, or null when the string is
 * not a plain non-negative decimal, carries more places than PayPal or ISO
 * allow for the currency, or names a currency of unknown scale.
 */
function parseWire(code: string, wire: string): number | null {
  const iso = minorUnitExponent(code);
  if (iso === null) return null;
  const match = WIRE_FORMAT.exec(wire.trim());
  if (!match) return null;
  // PayPal writes "5000.00" as readily as "5000", so trailing zeros carry no value.
  const fraction = (match[1] ?? '').replace(/0+$/, '');
  if (fraction.length > Math.min(wireDecimals(code), iso)) return null;
  const whole = wire.trim().split('.')[0] ?? '';
  const minor = Number(whole) * 10 ** iso + Number(fraction.padEnd(iso, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * A decimal string PayPal reported, as a stored amount. Refuses a value that
 * is not a whole number of stored units.
 *
 * @example
 * fromProviderAmount('USD', '19.99'); // 1999
 * fromProviderAmount('JPY', '5000');  // 5000
 * fromProviderAmount('HUF', '5000');  // 500000
 * fromProviderAmount('JPY', '50.5');  // throws BILLING_AMOUNT_NOT_CHARGEABLE
 */
export function fromProviderAmount(currency: string, wire: string): number {
  const code = normalise(currency);
  if (minorUnitExponent(code) === null) throw unknownCurrencyScale('PayPal', code);
  const minor = parseWire(code, wire);
  if (minor === null) {
    throw amountNotChargeable(
      'PayPal',
      code,
      `PayPal reported "${wire}", which is not a whole number of the smallest ${code} unit.`,
      `Check the transaction in the PayPal dashboard. A ${code} amount from PayPal is a plain decimal with at most ${wireDecimals(code)} decimal places.`,
    );
  }
  return minor;
}

/**
 * `fromProviderAmount` for a caller with a fallback of its own: null, not a
 * throw, on anything that is not exactly a stored amount.
 *
 * Used for a PayPal API RESPONSE (the refund just issued, an order read back)
 * and as the arithmetic under the webhook path's `paypalAmountToMinor`. That
 * one stays separate on purpose: it gates an untrusted inbound payload, so it
 * also takes a logger, enforces `MAX_PAYMENT_AMOUNT`, and its null drops the
 * whole event. None of that fits a provider method reading PayPal's echo.
 *
 * @example
 * paypalMinorFromMajor('49.99', 'USD'); // 4999
 * paypalMinorFromMajor('5000', 'HUF');  // 500000
 * paypalMinorFromMajor('abc', 'USD');   // null
 */
export function paypalMinorFromMajor(value: string, currency: string | undefined): number | null {
  return parseWire(normalise(currency), value);
}
