/**
 * A coupon in its wire shapes. Built from a named list of fields, so a column
 * added to the row is not sent until someone adds it here.
 */

import type { CouponDto, CouponWithStatsDto, PublicCouponDto } from '@rekey.dev/shared-types';
import type { CouponDiscountTotals } from './coupon-stats.js';
import { coveredCurrencies, termsOf, type CouponRecord } from './coupon-terms.js';

/**
 * The operator's view of a coupon.
 *
 * @example
 * serializeCoupon(coupon).amounts; // [{ currency: 'INR', amountOff: 40000 }, { currency: 'USD', amountOff: 500 }]
 */
export function serializeCoupon(coupon: CouponRecord): CouponDto {
  const terms = termsOf(coupon);
  return {
    id: coupon.id,
    applicationId: coupon.applicationId,
    code: coupon.code,
    discountType: coupon.discountType,
    basisPoints: terms.basisPoints,
    amounts: terms.amounts,
    currencies: terms.currencies,
    coveredCurrencies: coveredCurrencies(coupon),
    planSlugs: coupon.planSlugs,
    active: coupon.active,
    startsAt: coupon.startsAt?.toISOString() ?? null,
    endsAt: coupon.endsAt?.toISOString() ?? null,
    maxRedemptions: coupon.maxRedemptions,
    maxRedemptionsPerUser: coupon.maxRedemptionsPerUser,
    metadata: coupon.metadata as Record<string, unknown>,
    createdAt: coupon.createdAt.toISOString(),
    updatedAt: coupon.updatedAt.toISOString(),
  };
}

/** The operator's view with what the coupon has given away, per currency. */
export function serializeCouponWithStats(coupon: CouponRecord, totals: CouponDiscountTotals): CouponWithStatsDto {
  return {
    ...serializeCoupon(coupon),
    redemptionCount: totals.redemptionCount,
    discountIssuedByCurrency: totals.discountIssuedByCurrency,
  };
}

/**
 * What a buyer may see. Not the limits, the operator's `metadata`, the plan
 * allow-list or the currencies the coupon works in: the limits would tell a
 * scraper how much of a campaign is left, and the currencies which prices to
 * ask for.
 */
export function serializePublicCoupon(coupon: CouponRecord): PublicCouponDto {
  return { code: coupon.code, discountType: coupon.discountType, basisPoints: termsOf(coupon).basisPoints };
}
