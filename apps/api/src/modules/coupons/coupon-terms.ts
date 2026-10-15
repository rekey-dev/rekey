/**
 * What a coupon takes off, and in which currencies.
 *
 * A PERCENT coupon carries `basisPoints` and applies to a price in any
 * currency, unless `currencies` limits it. An AMOUNT coupon carries one
 * amount per currency and applies only in those. Operators price per country
 * for purchasing power, so an amount is never converted and never reused in
 * another currency.
 *
 * Pure: nothing here reads the database.
 */

import type { Coupon, CouponAmount, CouponDiscountType } from '@prisma/client';
import { chargeableStep, isSellableCurrency, percentageDiscount, validatePriceAmount } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';

/** A coupon with its per-currency amounts, which is how every reader loads one. */
export type CouponRecord = Coupon & { amounts: CouponAmount[] };

export interface CouponAmountInput {
  currency: string;
  amountOff: number;
}

/** The discount fields of a create or an update, as the caller sent them. */
export interface CouponTermsInput {
  basisPoints?: number | undefined;
  amounts?: readonly CouponAmountInput[] | undefined;
  currencies?: readonly string[] | undefined;
}

/** The discount fields as they are stored. */
export interface CouponTerms {
  basisPoints: number | null;
  /** Sorted by currency, upper case, one per currency. */
  amounts: CouponAmountInput[];
  /** Sorted, upper case. Empty means any currency. Always empty on an AMOUNT coupon. */
  currencies: string[];
}

const MAX_BASIS_POINTS = 10000;

function wrongKind(field: string, discountType: CouponDiscountType): RekeyError {
  const [takes, example] =
    discountType === 'PERCENT'
      ? ['`basisPoints`, and optionally `currencies`', '{ "discountType": "PERCENT", "basisPoints": 1500 }']
      : ['`amounts`', '{ "discountType": "AMOUNT", "amounts": [{ "currency": "USD", "amountOff": 500 }] }'];
  return new RekeyError({
    statusCode: 400,
    code: 'COUPON_DISCOUNT_SHAPE_INVALID',
    message: `\`${field}\` does not belong on a ${discountType} coupon.`,
    fix: `Remove \`${field}\`. A ${discountType} coupon takes ${takes}, for example ${example}.`,
  });
}

function currencyCode(raw: string, field: string): string {
  const code = raw.trim().toUpperCase();
  if (isSellableCurrency(code)) return code;
  throw new RekeyError({
    statusCode: 400,
    code: 'COUPON_CURRENCY_INVALID',
    message: `"${raw}" in \`${field}\` is not a currency a price can be in, so no checkout could use the coupon in it.`,
    fix: 'Send the ISO 4217 code of a currency your plans are priced in, such as USD, EUR or INR. Three-decimal currencies (KWD, BHD and others) and codes that are not money cannot be priced.',
  });
}

function normaliseAmounts(raw: readonly CouponAmountInput[]): CouponAmountInput[] {
  if (raw.length === 0) {
    throw new RekeyError({
      statusCode: 400,
      code: 'COUPON_AMOUNTS_REQUIRED',
      message: 'An AMOUNT coupon needs at least one amount: it takes nothing off in a currency it has no amount for.',
      fix: 'Send `amounts` with one entry per currency the coupon should work in, for example [{ "currency": "USD", "amountOff": 500 }]. `amountOff` is in the smallest unit of that currency.',
    });
  }
  const seen = new Set<string>();
  const amounts = raw.map((entry, index) => {
    const currency = currencyCode(entry.currency, `amounts[${index}].currency`);
    if (seen.has(currency)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_AMOUNT_INVALID',
        message: `\`amounts\` names ${currency} more than once.`,
        fix: `Send one entry per currency. Keep the ${currency} amount the coupon should take off and remove the other.`,
      });
    }
    seen.add(currency);
    const checked = validatePriceAmount(currency, entry.amountOff);
    if (!checked.ok) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_AMOUNT_INVALID',
        message: `The ${currency} amount of the coupon cannot be charged: ${checked.message}`,
        fix:
          checked.rule === 'not_whole_unit'
            ? `Send \`amountOff\` for ${currency} as a whole number of units written in hundredths: 50000 is ${currency} 500.`
            : `Send \`amountOff\` for ${currency} as a whole number above zero in the smallest ${currency} unit: 500 is 5.00 in a two-decimal currency and 500 in a zero-decimal one.`,
      });
    }
    return { currency, amountOff: entry.amountOff };
  });
  return amounts.sort((a, b) => a.currency.localeCompare(b.currency));
}

function normaliseBasisPoints(basisPoints: number | undefined): number {
  if (basisPoints !== undefined && Number.isInteger(basisPoints) && basisPoints >= 1 && basisPoints <= MAX_BASIS_POINTS) {
    return basisPoints;
  }
  throw new RekeyError({
    statusCode: 400,
    code: 'COUPON_AMOUNT_INVALID',
    message:
      basisPoints === undefined
        ? 'A PERCENT coupon needs `basisPoints`.'
        : `\`basisPoints\` of ${String(basisPoints)} is not between 1 and ${MAX_BASIS_POINTS}.`,
    fix: 'Send `basisPoints` as a whole number of hundredths of a percent, from 1 to 10000: 1500 is 15% and 10000 is 100%.',
  });
}

/**
 * Check the discount fields of a new coupon and return them as stored.
 *
 * @example
 * couponTermsFor('AMOUNT', { amounts: [{ currency: 'usd', amountOff: 500 }] });
 * // { basisPoints: null, amounts: [{ currency: 'USD', amountOff: 500 }], currencies: [] }
 */
export function couponTermsFor(discountType: CouponDiscountType, input: CouponTermsInput): CouponTerms {
  if (discountType === 'PERCENT') {
    if (input.amounts !== undefined) throw wrongKind('amounts', discountType);
    const currencies = (input.currencies ?? []).map((code, index) => currencyCode(code, `currencies[${index}]`));
    return { basisPoints: normaliseBasisPoints(input.basisPoints), amounts: [], currencies: [...new Set(currencies)].sort() };
  }
  if (input.basisPoints !== undefined) throw wrongKind('basisPoints', discountType);
  if (input.currencies !== undefined) throw wrongKind('currencies', discountType);
  return { basisPoints: null, amounts: normaliseAmounts(input.amounts ?? []), currencies: [] };
}

/** The stored terms of a coupon. */
export function termsOf(coupon: CouponRecord): CouponTerms {
  return {
    basisPoints: coupon.discountType === 'PERCENT' ? coupon.basisPoints : null,
    amounts: coupon.amounts
      .map(({ currency, amountOff }) => ({ currency, amountOff }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    currencies: coupon.discountType === 'PERCENT' ? [...coupon.currencies].sort() : [],
  };
}

/**
 * A coupon's terms after an update that sends some of the discount fields, or
 * null when it sends none of them. A field left out keeps its stored value.
 *
 * Null matters for a fixed coupon left with no amounts: switching it off
 * must not be refused for that.
 *
 * @example
 * couponTermsAfter(coupon, { amounts: [{ currency: 'EUR', amountOff: 450 }] })?.amounts; // the EUR amount only
 * couponTermsAfter(coupon, {}); // null
 */
export function couponTermsAfter(coupon: CouponRecord, change: CouponTermsInput): CouponTerms | null {
  if (change.basisPoints === undefined && change.amounts === undefined && change.currencies === undefined) return null;
  const stored = termsOf(coupon);
  if (coupon.discountType === 'PERCENT') {
    return couponTermsFor('PERCENT', {
      basisPoints: change.basisPoints ?? stored.basisPoints ?? undefined,
      amounts: change.amounts,
      currencies: change.currencies ?? stored.currencies,
    });
  }
  return couponTermsFor('AMOUNT', {
    basisPoints: change.basisPoints,
    currencies: change.currencies,
    amounts: change.amounts ?? stored.amounts,
  });
}

/**
 * Every currency a checkout may use the coupon in, or null for any.
 *
 * @example
 * coveredCurrencies(fixedUsdAndInr); // ['INR', 'USD']
 * coveredCurrencies(percentAnywhere); // null
 */
export function coveredCurrencies(coupon: CouponRecord): string[] | null {
  const terms = termsOf(coupon);
  if (coupon.discountType === 'AMOUNT') return terms.amounts.map((amount) => amount.currency);
  return terms.currencies.length === 0 ? null : terms.currencies;
}

/**
 * What the coupon takes off `amount` in `currency`, as an amount every
 * provider can charge, or null when the coupon does not work in that
 * currency. The one place a discount is worked out: the preview, the
 * checkout and the figure handed to the provider all come from here.
 *
 * A percentage is rounded toward the buyer. Neither kind takes off more than
 * the price.
 *
 * @example
 * computeDiscount(fifteenPercent, 1999, 'USD'); // 300
 * computeDiscount(fiveDollarsOff, 149900, 'INR'); // null: no INR amount
 */
export function computeDiscount(coupon: CouponRecord, amount: number, currency: string): number | null {
  const charged = currency.toUpperCase();
  if (coupon.discountType === 'PERCENT') {
    const limitedTo = coupon.currencies.map((code) => code.toUpperCase());
    if (limitedTo.length > 0 && !limitedTo.includes(charged)) return null;
    return percentageDiscount(charged, amount, coupon.basisPoints ?? 0);
  }
  const fixed = coupon.amounts.find((row) => row.currency.toUpperCase() === charged);
  if (fixed === undefined) return null;
  const step = chargeableStep(charged);
  return Math.min(Math.ceil(fixed.amountOff / step) * step, amount);
}

const REMOVED_FIELDS = {
  amountOff:
    'For a PERCENT coupon send `basisPoints` (1500 is 15%). For an AMOUNT coupon send `amounts`, one entry per currency: [{ "currency": "USD", "amountOff": 500 }].',
  currency:
    'An AMOUNT coupon names its currencies in `amounts`: [{ "currency": "USD", "amountOff": 500 }]. To limit a PERCENT coupon to some currencies send `currencies`: ["USD"].',
} as const;

/**
 * Refuse a coupon body that still sends a field the money model removed, so
 * an older client fails loudly instead of creating a coupon with no discount.
 *
 * @example
 * assertNoRemovedCouponFields(req.body); // throws BILLING_FIELD_REMOVED for { amountOff: 500 }
 */
export function assertNoRemovedCouponFields(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  for (const [field, fix] of Object.entries(REMOVED_FIELDS)) {
    if (!(field in body)) continue;
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_FIELD_REMOVED',
      message: `A coupon no longer takes \`${field}\`.`,
      fix,
    });
  }
}
