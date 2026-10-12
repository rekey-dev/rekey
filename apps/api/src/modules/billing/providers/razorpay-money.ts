/**
 * Razorpay's wire scale: the conversion between a stored amount (an integer
 * at the ISO 4217 exponent) and the integer Razorpay's API takes and reports.
 */

import { isSellableCurrency, minorUnitExponent } from '@rekey.dev/shared-types';
import { amountNotChargeable, unknownCurrencyScale } from './amount-not-chargeable.js';

/**
 * Currencies whose exponent at Razorpay differs from ISO 4217. There are
 * none: the exponent column of Razorpay's supported-currency table matches
 * ISO for every code it lists, the zero-decimal ones (JPY, ISK and UGX at 0),
 * the three-decimal ones (KWD at 3, "pass 99999 for 99.999 KD") and HUF, TWD
 * and MGA at 2. A stored amount is therefore the wire amount.
 * https://razorpay.com/docs/payments/international-payments/#supported-currencies
 *
 * Kept as a table so a future difference is one entry, not a new code path.
 */
const RAZORPAY_EXPONENT_OVERRIDES: ReadonlyMap<string, 0 | 2 | 3> = new Map();

/**
 * The currencies in Razorpay's supported-currency table (same page).
 * https://razorpay.com/docs/payments/international-payments/#supported-currencies
 */
const RAZORPAY_LISTED_CURRENCIES: readonly string[] = [
  'AED', 'ALL', 'AMD', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BZD', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP',
  'DZD', 'EGP', 'ETB', 'EUR', 'FJD', 'GBP', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG',
  'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KRW', 'KWD', 'KYD',
  'KZT', 'LAK', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MUR', 'MVR', 'MWK', 'MXN',
  'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
  'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SCR', 'SEK', 'SGD', 'SLL', 'SOS', 'SVC', 'SZL', 'THB', 'TND', 'TRY', 'TTD',
  'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VND', 'VUV', 'XAF', 'XCD', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW',
];

/**
 * What a Razorpay account can charge once international payments are on:
 * Razorpay's list less what a Rekey price may not be in (the three-decimal
 * currencies and the withdrawn HRK and SLL).
 */
export const RAZORPAY_SUPPORTED_CURRENCIES: readonly string[] = RAZORPAY_LISTED_CURRENCIES.filter(isSellableCurrency);

function normalise(currency: string | null | undefined): string {
  return (currency ?? '').trim().toUpperCase();
}

/** Decimal places between a stored amount and Razorpay's, or null for an unknown currency. */
function placesToWire(code: string): number | null {
  const iso = minorUnitExponent(code);
  if (iso === null) return null;
  return (RAZORPAY_EXPONENT_OVERRIDES.get(code) ?? iso) - iso;
}

/** `amount` moved by `places` decimal places, or null when that is not a whole number. */
function shift(amount: number, places: number): number | null {
  if (places >= 0) return amount * 10 ** places;
  const divisor = 10 ** -places;
  return amount % divisor === 0 ? amount / divisor : null;
}

function convert(currency: string, amount: number, direction: 1 | -1, subject: string): number {
  const code = normalise(currency);
  const places = placesToWire(code);
  if (places === null) throw unknownCurrencyScale('Razorpay', code);
  const converted = Number.isSafeInteger(amount) ? shift(amount, direction * places) : null;
  if (converted === null) {
    throw amountNotChargeable(
      'Razorpay',
      code,
      `${subject} ${String(amount)} is not a whole number of the smallest ${code} unit.`,
      `Use an integer in the smallest ${code} unit (paise for INR, cents for USD, whole yen for JPY).`,
    );
  }
  return converted;
}

/**
 * A stored amount as the integer Razorpay's API takes for that currency.
 * Refuses a fractional amount and a currency of unknown scale.
 *
 * @example
 * toProviderAmount('INR', 49900); // 49900 (499.00 rupees in paise)
 * toProviderAmount('JPY', 5000);  // 5000
 * toProviderAmount('ABC', 100);   // throws BILLING_AMOUNT_NOT_CHARGEABLE
 */
export function toProviderAmount(currency: string, amountMinor: number): number {
  return convert(currency, amountMinor, 1, 'The amount');
}

/**
 * An integer Razorpay reported, as a stored amount.
 *
 * @example
 * fromProviderAmount('INR', 49900); // 49900
 * fromProviderAmount('ISK', 5000);  // 5000
 */
export function fromProviderAmount(currency: string, wire: number): number {
  return convert(currency, wire, -1, 'Razorpay reported');
}

/**
 * The stored amount for a figure read off a Razorpay webhook, for the
 * applier's amount gate to judge. Never throws: a throw there answers 500 and
 * Razorpay redelivers the same body.
 *
 * No amount, no currency, or a currency Rekey has no record of: the figure is
 * passed on as Razorpay sent it. A figure that is not a whole number of
 * stored units becomes NaN, which the applier's gate logs and drops.
 *
 * @example
 * razorpayWebhookAmount('INR', 49900);     // 49900
 * razorpayWebhookAmount(undefined, 49900); // 49900
 */
export function razorpayWebhookAmount(
  currency: string | null | undefined,
  wire: number | null | undefined,
): number | null | undefined {
  if (typeof wire !== 'number') return wire;
  const places = placesToWire(normalise(currency));
  if (places === null) return wire;
  if (!Number.isSafeInteger(wire)) return Number.NaN;
  return shift(wire, -places) ?? Number.NaN;
}
