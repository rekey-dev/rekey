/**
 * Stripe's wire scale: the conversion between a stored amount (an integer at
 * the ISO 4217 exponent) and the integer Stripe's API takes and reports.
 */

import { isSellableCurrency, minorUnitExponent } from '@rekey.dev/shared-types';
import { amountNotChargeable, unknownCurrencyScale } from './amount-not-chargeable.js';

type Exponent = 0 | 2 | 3;

/**
 * Currencies Stripe takes with no decimal places, read from the page on
 * 2026-10-11. https://docs.stripe.com/currencies#zero-decimal
 *
 * Every entry but MGA is zero-decimal in ISO as well. ISO gives MGA two
 * places, so a stored MGA amount is divided by 100 on the way out.
 */
const STRIPE_ZERO_DECIMAL: ReadonlySet<string> = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * Currencies with no minor unit that Stripe still takes as a two-decimal
 * amount ending in 00: "to charge 5 ISK, provide an amount value of 500".
 * https://docs.stripe.com/currencies#special-cases
 *
 * UGX is on the zero-decimal list too. The special case is the more specific
 * statement and wins here.
 */
const STRIPE_TWO_DECIMAL_ALWAYS_00: ReadonlySet<string> = new Set(['ISK', 'UGX']);

/**
 * Every presentment currency Stripe lists for any account country, read from
 * the page on 2026-10-11. BHD, JOD, KWD, OMR and TND are listed for accounts
 * in the United Arab Emirates only.
 * https://docs.stripe.com/currencies#presentment-currencies
 */
const STRIPE_LISTED_CURRENCIES: readonly string[] = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BHD', 'BIF', 'BMD',
  'BND', 'BOB', 'BRL', 'BSD', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KRW',
  'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MUR',
  'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP',
  'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS',
  'SRD', 'STD', 'SZL', 'THB', 'TJS', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS',
  'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW',
];

/**
 * The listed currencies a Rekey price may be in: the list less the
 * three-decimal ones and STD, a code ISO 4217 has withdrawn.
 */
export const STRIPE_SUPPORTED_CURRENCIES: readonly string[] = STRIPE_LISTED_CURRENCIES.filter(isSellableCurrency);

function normalise(currency: string | null | undefined): string {
  return (currency ?? '').trim().toUpperCase();
}

function stripeExponent(code: string, iso: Exponent): Exponent {
  if (STRIPE_TWO_DECIMAL_ALWAYS_00.has(code)) return 2;
  if (STRIPE_ZERO_DECIMAL.has(code)) return 0;
  return iso;
}

function isoExponentOrThrow(code: string): Exponent {
  const iso = minorUnitExponent(code);
  if (iso === null) throw unknownCurrencyScale('Stripe', code);
  return iso;
}

/** `amount` moved by `places` decimal places, or null when that is not a whole number. */
function shift(amount: number, places: number): number | null {
  if (places >= 0) return amount * 10 ** places;
  const divisor = 10 ** -places;
  return amount % divisor === 0 ? amount / divisor : null;
}

/**
 * A stored amount as the integer Stripe's API takes for that currency.
 * Refuses, never rounds, an amount Stripe cannot take exactly.
 *
 * @example
 * toProviderAmount('USD', 1999);   // 1999
 * toProviderAmount('JPY', 5000);   // 5000
 * toProviderAmount('ISK', 5000);   // 500000: Stripe reads it as 5000.00 kr
 * toProviderAmount('MGA', 150000); // 1500: Stripe takes MGA with no decimals
 * toProviderAmount('MGA', 150050); // throws BILLING_AMOUNT_NOT_CHARGEABLE
 */
export function toProviderAmount(currency: string, amountMinor: number): number {
  const code = normalise(currency);
  const iso = isoExponentOrThrow(code);
  if (!Number.isSafeInteger(amountMinor)) {
    throw amountNotChargeable(
      'Stripe',
      code,
      `${String(amountMinor)} is not a whole number of the smallest ${code} unit.`,
      `Send the amount as an integer in the smallest ${code} unit.`,
    );
  }
  const wire = shift(amountMinor, stripeExponent(code, iso) - iso);
  if (wire === null) {
    throw amountNotChargeable(
      'Stripe',
      code,
      `Stripe takes ${code} in whole units, and ${amountMinor} is not a whole number of them.`,
      `Use a ${code} amount that ends in 00.`,
    );
  }
  // Stripe's three-decimal rule was not on the page when this was written;
  // its long-standing one is that the last digit is 0. No three-decimal
  // currency is sellable, so this only guards a caller that skipped that check.
  if (iso === 3 && wire % 10 !== 0) {
    throw amountNotChargeable(
      'Stripe',
      code,
      `Stripe takes ${code} to two of its three decimal places, and ${amountMinor} uses the third.`,
      `Use a ${code} amount that ends in 0.`,
    );
  }
  return wire;
}

/**
 * An integer Stripe reported, as a stored amount. Refuses a value that is not
 * a whole number of stored units.
 *
 * @example
 * fromProviderAmount('USD', 1999);   // 1999
 * fromProviderAmount('ISK', 500000); // 5000
 * fromProviderAmount('MGA', 1500);   // 150000
 * fromProviderAmount('UGX', 550);    // throws BILLING_AMOUNT_NOT_CHARGEABLE
 */
export function fromProviderAmount(currency: string, wire: number): number {
  const code = normalise(currency);
  const iso = isoExponentOrThrow(code);
  const stored = Number.isSafeInteger(wire) ? shift(wire, iso - stripeExponent(code, iso)) : null;
  if (stored === null) {
    throw amountNotChargeable(
      'Stripe',
      code,
      `Stripe reported ${String(wire)}, which is not a whole number of the smallest ${code} unit.`,
      `Check the charge in the Stripe dashboard. A ${code} amount from Stripe should be a whole number of ${code}.`,
    );
  }
  return stored;
}

/**
 * The stored amount for a figure read off a Stripe webhook, for the
 * applier's amount gate to judge. Never throws: a throw there answers 500 and
 * Stripe redelivers the same body for days.
 *
 * - no amount: passed on untouched.
 * - no currency, or one Rekey has no record of: the figure is passed on as
 *   Stripe sent it, and the applier's currency check decides what to file.
 * - a figure that is not a whole number of stored units: NaN, which the
 *   applier's gate logs and drops.
 *
 * @example
 * stripeWebhookAmount('isk', 500000); // 5000
 * stripeWebhookAmount('usd', null);   // null
 * stripeWebhookAmount(null, 1999);    // 1999
 */
export function stripeWebhookAmount(currency: string | null | undefined, wire: number): number;
export function stripeWebhookAmount(
  currency: string | null | undefined,
  wire: number | null | undefined,
): number | null | undefined;
export function stripeWebhookAmount(
  currency: string | null | undefined,
  wire: number | null | undefined,
): number | null | undefined {
  if (typeof wire !== 'number') return wire;
  const code = normalise(currency);
  const iso = minorUnitExponent(code);
  if (iso === null) return wire;
  if (!Number.isSafeInteger(wire)) return Number.NaN;
  return shift(wire, iso - stripeExponent(code, iso)) ?? Number.NaN;
}
