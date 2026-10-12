/**
 * What Rekey knows about currencies: which exist, how many decimal places a
 * stored amount has, where each is local, and which a price may be in.
 *
 * Amounts are stored as integers at the ISO 4217 exponent. A provider that
 * scales a currency differently converts at its own edge; nothing here knows
 * about providers.
 */

import { CURRENCY_TABLE, type CurrencyRecord } from './data.js';

/**
 * Codes ISO 4217 assigns to things that are not money a buyer can pay with:
 * metals, bond units, testing and "no currency" codes, and the accounting
 * units some countries keep beside their real currency.
 */
const NOT_MONEY: ReadonlySet<string> = new Set([
  'XAU', 'XAG', 'XPT', 'XPD', 'XBA', 'XBB', 'XBC', 'XBD', 'XDR', 'XSU', 'XTS', 'XUA', 'XXX',
  'BOV', 'CHE', 'CHW', 'CLF', 'COU', 'MXV', 'USN', 'UYI', 'UYW',
]);

/** Codes ISO 4217 has withdrawn that runtimes still list. No provider charges them. */
const WITHDRAWN: ReadonlySet<string> = new Set(['CUC', 'HRK', 'SLL', 'ZWL']);

/**
 * Currencies priced in whole units only, so a stored amount must be a multiple
 * of 100. Stripe takes HUF and TWD with two decimals and PayPal refuses
 * decimals on both; Stripe takes MGA with none, and its subunit is a fifth,
 * which two decimals cannot express. A whole-unit price is the one amount
 * every provider can charge exactly.
 */
const WHOLE_UNITS_ONLY: ReadonlySet<string> = new Set(['HUF', 'TWD', 'MGA']);

export type { CurrencyRecord };

export type UnsellableReason = 'unknown' | 'not_money' | 'withdrawn' | 'three_decimal';

export type CurrencySellability =
  | { sellable: true; wholeUnitsOnly: boolean }
  | { sellable: false; reason: UnsellableReason };

function normalise(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The table row for a currency, or null for a code Rekey does not know. Case
 * and surrounding space are ignored.
 *
 * @example
 * currencyRecord('jpy'); // { code: 'JPY', name: 'Japanese Yen', exponent: 0, countries: ['JP'] }
 * currencyRecord('ABC'); // null
 */
export function currencyRecord(code: string): CurrencyRecord | null {
  return CURRENCY_TABLE[normalise(code)] ?? null;
}

/**
 * How many decimal places a stored amount in this currency has, or null for
 * an unknown code.
 *
 * @example
 * minorUnitExponent('USD'); // 2
 * minorUnitExponent('JPY'); // 0
 */
export function minorUnitExponent(code: string): 0 | 2 | 3 | null {
  return currencyRecord(code)?.exponent ?? null;
}

/**
 * Whether a Rekey price may be in this currency, and why not when it may not.
 *
 * @example
 * currencySellability('HUF'); // { sellable: true, wholeUnitsOnly: true }
 * currencySellability('KWD'); // { sellable: false, reason: 'three_decimal' }
 */
export function currencySellability(code: string): CurrencySellability {
  const upper = normalise(code);
  if (NOT_MONEY.has(upper)) return { sellable: false, reason: 'not_money' };
  const record = CURRENCY_TABLE[upper];
  if (!record) return { sellable: false, reason: 'unknown' };
  if (WITHDRAWN.has(upper)) return { sellable: false, reason: 'withdrawn' };
  // No provider takes a three-decimal amount as written: Stripe and Razorpay
  // need the last digit to be 0 and PayPal takes none of them.
  if (record.exponent === 3) return { sellable: false, reason: 'three_decimal' };
  return { sellable: true, wholeUnitsOnly: WHOLE_UNITS_ONLY.has(upper) };
}

/**
 * Whether a Rekey price may be in this currency.
 *
 * @example
 * isSellableCurrency('INR'); // true
 * isSellableCurrency('XAU'); // false: gold is not money
 * isSellableCurrency('BHD'); // false: three decimals
 */
export function isSellableCurrency(code: string): boolean {
  return currencySellability(code).sellable;
}

/**
 * Every currency a price may be in, sorted by code.
 *
 * @example
 * sellableCurrencies().includes('USD'); // true
 */
export function sellableCurrencies(): string[] {
  return Object.keys(CURRENCY_TABLE).filter(isSellableCurrency).sort();
}

export type PriceAmountRule =
  | 'currency_not_sellable'
  | 'not_integer'
  | 'not_positive'
  | 'not_whole_unit'
  | 'too_large';

/**
 * The largest amount a price may have, in minor units: what the 32-bit
 * integer column an amount is stored in can hold.
 */
export const MAX_PRICE_AMOUNT = 2_147_483_647;

export type PriceAmountValidation = { ok: true } | { ok: false; rule: PriceAmountRule; message: string };

/**
 * Check an amount a price is about to be saved with. `amount` is in the
 * currency's minor unit.
 *
 * @example
 * validatePriceAmount('USD', 1999);    // { ok: true }
 * validatePriceAmount('HUF', 500050);  // { ok: false, rule: 'not_whole_unit', message: '...' }
 * validatePriceAmount('USD', 19.99);   // { ok: false, rule: 'not_integer', message: '...' }
 * validatePriceAmount('USD', 3e9);     // { ok: false, rule: 'too_large', message: '...' }
 */
export function validatePriceAmount(currency: string, amount: number): PriceAmountValidation {
  const code = normalise(currency);
  const sellability = currencySellability(code);
  if (!sellability.sellable) {
    return { ok: false, rule: 'currency_not_sellable', message: `${code} is not a currency a price can be in.` };
  }
  if (!Number.isSafeInteger(amount)) {
    return {
      ok: false,
      rule: 'not_integer',
      message: `An amount is a whole number of the smallest ${code} unit, and ${String(amount)} is not one.`,
    };
  }
  if (amount <= 0) {
    return { ok: false, rule: 'not_positive', message: 'A price is greater than zero.' };
  }
  if (amount > MAX_PRICE_AMOUNT) {
    return {
      ok: false,
      rule: 'too_large',
      message: `An amount is at most ${MAX_PRICE_AMOUNT} of the smallest ${code} unit, and ${amount} is more.`,
    };
  }
  if (sellability.wholeUnitsOnly && amount % 100 !== 0) {
    return {
      ok: false,
      rule: 'not_whole_unit',
      message: `${code} is priced in whole units, so the amount must end in 00.`,
    };
  }
  return { ok: true };
}

/**
 * The smallest difference between two amounts that every provider can charge
 * in this currency, in minor units: 100 where prices are whole units only, 1
 * elsewhere and for a code Rekey does not know.
 *
 * @example
 * chargeableStep('USD'); // 1
 * chargeableStep('HUF'); // 100
 */
export function chargeableStep(currency: string): number {
  const sellability = currencySellability(currency);
  return sellability.sellable && sellability.wholeUnitsOnly ? 100 : 1;
}

/**
 * What a percentage coupon takes off an amount, as an amount that can be
 * charged. `amount` is in minor units and `basisPoints` is hundredths of a
 * percent: 1500 is 15%.
 *
 * A discount that is not a whole number of chargeable steps is rounded UP to
 * the next one, toward the buyer, in every currency: 15% of 19.99 takes 3.00
 * and leaves 16.99. Never more than the amount.
 *
 * @example
 * percentageDiscount('USD', 1999, 1500);   // 300
 * percentageDiscount('USD', 1000, 1500);   // 150: exact, nothing to round
 * percentageDiscount('HUF', 499000, 1500); // 74900: HUF 749, leaving HUF 4,241
 */
export function percentageDiscount(currency: string, amount: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(basisPoints) || amount <= 0 || basisPoints <= 0) return 0;
  const step = chargeableStep(currency);
  // Remainder and exact quotient rather than a float division: a quotient a
  // hair off a whole number must not round a discount up by a whole step.
  const scaled = amount * basisPoints;
  const perStep = 10000 * step;
  const remainder = scaled % perStep;
  const steps = (scaled - remainder) / perStep + (remainder > 0 ? 1 : 0);
  return Math.min(steps * step, amount);
}

const LOCAL_CURRENCY: ReadonlyMap<string, string> = new Map(
  Object.values(CURRENCY_TABLE).flatMap((record) => record.countries.map((country) => [country, record.code] as const)),
);

/**
 * The currency a country's buyers ordinarily pay in, or null for a territory
 * with none or a code that is not a country.
 *
 * @example
 * localCurrencyOf('IN'); // 'INR'
 * localCurrencyOf('de'); // 'EUR'
 * localCurrencyOf('AQ'); // null
 */
export function localCurrencyOf(country: string): string | null {
  return LOCAL_CURRENCY.get(normalise(country)) ?? null;
}
