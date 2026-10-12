/**
 * What each coupon has given away, per currency.
 *
 * A coupon can be redeemed in several currencies. They are never added
 * together and there is no total: one row per currency, the Application's
 * reporting currency first.
 */

import { prisma } from '../../lib/prisma.js';
import { reportingCurrency } from '../billing/reporting-currency.js';
import type { CouponRecord } from './coupon-terms.js';

export interface CouponCurrencyTotal {
  currency: string;
  /** Discount given, in the smallest unit of `currency`. */
  amount: number;
  redemptions: number;
}

export interface CouponDiscountTotals {
  /** CONFIRMED redemptions, in every currency. */
  redemptionCount: number;
  /** One row per currency charged: the reporting currency first, then by redemptions, then by code. */
  discountIssuedByCurrency: CouponCurrencyTotal[];
}

const NO_REDEMPTIONS: CouponDiscountTotals = { redemptionCount: 0, discountIssuedByCurrency: [] };

type StatsCoupon = Pick<CouponRecord, 'id' | 'discountType' | 'amounts'>;

/**
 * Redemption totals for a page of coupons, in one grouped query.
 *
 * A redemption recorded before currencies were kept has none. A fixed-amount
 * coupon with a single amount can only have been redeemed in that currency,
 * at that amount, so such a row is placed there. Any other is counted in
 * `redemptionCount` and in no currency: placing it would be a guess.
 *
 * @example
 * const totals = await couponDiscountTotals(applicationId, coupons);
 * totals.get(coupon.id)?.discountIssuedByCurrency;
 * // [{ currency: 'USD', amount: 1500, redemptions: 3 }, { currency: 'INR', amount: 20000, redemptions: 1 }]
 */
export async function couponDiscountTotals(
  applicationId: string,
  coupons: readonly StatsCoupon[],
): Promise<Map<string, CouponDiscountTotals>> {
  const result = new Map<string, CouponDiscountTotals>();
  if (coupons.length === 0) return result;

  const [grouped, application] = await Promise.all([
    prisma.couponRedemption.groupBy({
      by: ['couponId', 'currency'],
      // Reservations are money that has not moved.
      where: { couponId: { in: coupons.map((c) => c.id) }, status: 'CONFIRMED' },
      _count: { _all: true, discountAmount: true },
      _sum: { discountAmount: true },
    }),
    prisma.application.findUnique({ where: { id: applicationId }, select: { billingConfig: true } }),
  ]);
  const reporting = reportingCurrency({ billingConfig: application?.billingConfig ?? {} });

  for (const coupon of coupons) {
    const groups = grouped.filter((g) => g.couponId === coupon.id);
    if (groups.length === 0) {
      result.set(coupon.id, NO_REDEMPTIONS);
      continue;
    }
    const onlyAmount = coupon.discountType === 'AMOUNT' && coupon.amounts.length === 1 ? coupon.amounts[0] : undefined;
    const byCurrency = new Map<string, CouponCurrencyTotal>();
    for (const g of groups) {
      const currency = (g.currency ?? onlyAmount?.currency)?.toUpperCase();
      if (currency === undefined) continue;
      // Rows older than `discount_amount` have it NULL and `_sum` skips them.
      const unstamped = g._count._all - g._count.discountAmount;
      const amount = (g._sum.discountAmount ?? 0) + (onlyAmount === undefined ? 0 : unstamped * onlyAmount.amountOff);
      const seen = byCurrency.get(currency) ?? { currency, amount: 0, redemptions: 0 };
      byCurrency.set(currency, { currency, amount: seen.amount + amount, redemptions: seen.redemptions + g._count._all });
    }
    result.set(coupon.id, {
      redemptionCount: groups.reduce((n, g) => n + g._count._all, 0),
      discountIssuedByCurrency: [...byCurrency.values()].sort(
        (a, b) =>
          Number(b.currency === reporting) - Number(a.currency === reporting) ||
          b.redemptions - a.redemptions ||
          a.currency.localeCompare(b.currency),
      ),
    });
  }
  return result;
}
