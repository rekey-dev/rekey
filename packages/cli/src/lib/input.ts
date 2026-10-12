/**
 * Parsers for the values billing commands take on the command line. Each one
 * refuses a bad value with a CLI code and a fix before any request is sent.
 */

import { validatePriceAmount, type PriceAmountRule } from '@rekey.dev/node';
import { fail, type OutputContext } from './output.js';

/** How every amount flag describes its unit. */
export const MINOR_UNITS_HELP = 'minor units of the currency, e.g. 1900 for $19.00, 5000 for ¥5,000';

const AMOUNT_FIX: Record<PriceAmountRule, string> = {
  currency_not_sellable:
    'Use a currency a price can be in. Three-decimal currencies such as KWD and BHD, and codes that are not money, cannot be priced.',
  not_integer:
    'Pass a whole number of minor units: 1900 for $19.00, 5000 for ¥5,000. Decimals are refused so nothing is rounded.',
  not_positive: 'Pass a whole number above 0, in minor units of the currency.',
  not_whole_unit: 'This currency is priced in whole units: end the amount in 00, for example 500000 for 5,000.',
  too_large: 'Pass an amount of at most 2147483647 minor units.',
};

/** Where a parsed value came from, for the error: the code to fail with and the flag or argument name. */
export interface InputSource {
  code: string;
  what: string;
}

/**
 * An upper-case ISO 4217 code, or a refusal.
 *
 * @example
 * readCurrency(ctx, 'inr', { code: 'CLI_PLANS_CURRENCY_INVALID', what: '<currency>' }); // 'INR'
 */
export function readCurrency(ctx: OutputContext, raw: string, source: InputSource): string {
  const currency = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) return currency;
  fail(ctx, {
    code: source.code,
    message: `${source.what} must be a three-letter ISO 4217 code. Got "${raw}".`,
    fix: 'Pass a code such as USD, INR or JPY.',
  });
}

/**
 * An amount in minor units of `currency` that a price or a coupon may carry.
 *
 * @example
 * readMinorUnits(ctx, '5000', 'JPY', { code: 'CLI_PLANS_AMOUNT_INVALID', what: '<amount>' }); // 5000
 */
export function readMinorUnits(ctx: OutputContext, raw: string, currency: string, source: InputSource): number {
  const text = raw.trim();
  const amount = /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
  const checked = validatePriceAmount(currency, amount);
  if (checked.ok) return amount;
  fail(ctx, {
    code: source.code,
    message:
      checked.rule === 'not_integer'
        ? `${source.what} must be a whole number of minor units of ${currency}. Got "${raw}".`
        : `${source.what}: ${checked.message}`,
    fix: AMOUNT_FIX[checked.rule],
  });
}

/**
 * A whole number between two bounds.
 *
 * @example
 * readInteger(ctx, '20', { code: 'CLI_BILLING_LIMIT_INVALID', what: '--limit' }, 1, 200); // 20
 */
export function readInteger(ctx: OutputContext, raw: string, source: InputSource, min: number, max: number): number {
  const value = /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  fail(ctx, {
    code: source.code,
    message: `${source.what} must be a whole number from ${min} to ${max}. Got "${raw}".`,
    fix: `Pass a whole number between ${min} and ${max}.`,
  });
}

/** The items of a comma list, trimmed, with empty ones dropped. `""` is the empty list. */
export function readList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Upper-case ISO 4217 codes from a comma list, without repeats.
 *
 * @example
 * readCurrencies(ctx, 'usd, eur', { code: 'CLI_COUPONS_CURRENCIES_INVALID', what: '--currencies' }); // ['USD', 'EUR']
 */
export function readCurrencies(ctx: OutputContext, raw: string, source: InputSource): string[] {
  return [...new Set(readList(raw).map((item) => readCurrency(ctx, item, source)))];
}

/**
 * Upper-case ISO 3166-1 alpha-2 codes from a comma list, without repeats.
 *
 * @example
 * readCountries(ctx, 'in, np', { code: 'CLI_PLANS_COUNTRIES_INVALID', what: '--countries' }); // ['IN', 'NP']
 */
export function readCountries(ctx: OutputContext, raw: string, source: InputSource): string[] {
  const countries = readList(raw).map((country) => country.toUpperCase());
  const bad = countries.filter((country) => !/^[A-Z]{2}$/.test(country));
  if (bad.length === 0) return [...new Set(countries)];
  fail(ctx, {
    code: source.code,
    message: `${source.what} takes two-letter ISO 3166-1 codes separated by commas. Got "${bad.join(', ')}".`,
    fix: 'Pass codes such as IN,NP.',
  });
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * An instant as the API takes it (`2026-10-01T00:00:00.000Z`), from an ISO
 * 8601 date-time with its zone, or a bare date read as midnight UTC. A time
 * with no zone is refused: the CLI would have to guess whose midnight.
 *
 * @example
 * readInstant(ctx, '2026-10-01', { code: 'CLI_DATE_INVALID', what: '--from' }); // '2026-10-01T00:00:00.000Z'
 */
export function readInstant(ctx: OutputContext, raw: string, source: InputSource): string {
  const text = raw.trim();
  const time = ISO_INSTANT.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isNaN(time)) return new Date(time).toISOString();
  fail(ctx, {
    code: source.code,
    message: `${source.what} must be an ISO 8601 instant. Got "${raw}".`,
    fix: 'Pass a date such as 2026-10-01 (midnight UTC), or a time with its zone such as 2026-10-01T09:30:00Z.',
  });
}

/**
 * One of a closed set of words.
 *
 * @example
 * readChoice(ctx, 'hint', ['declared', 'vouched', 'hint'], { code: 'CLI_BILLING_COUNTRY_SOURCE_INVALID', what: '--country-source' });
 */
export function readChoice<T extends string>(
  ctx: OutputContext,
  raw: string,
  choices: readonly T[],
  source: InputSource,
): T {
  const found = choices.find((choice) => choice === raw);
  if (found !== undefined) return found;
  fail(ctx, {
    code: source.code,
    message: `${source.what} must be one of ${choices.join(', ')}. Got "${raw}".`,
    fix: `Pass ${source.what} ${choices.join(' or ')}.`,
  });
}

/** `?a=b&c=d` from the values that are set, or `''`. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** The path of an operator route under one Application. */
export function appPath(app: string, rest: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(app)}${rest}`;
}
