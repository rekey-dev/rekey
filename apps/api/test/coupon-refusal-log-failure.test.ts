/**
 * `resolveCheckoutDiscount` is synchronous and writes its `coupon.refused`
 * event without waiting. A write that fails must be logged, never left as an
 * unhandled rejection: under Node's default that ends the process.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as couponEvents from '../src/modules/coupons/coupon-events.js';
import { resolveCheckoutDiscount } from '../src/modules/billing/checkout-discount.js';
import type { PricedPlan } from '../src/modules/billing/providers/types.js';

describe('a coupon refusal whose log write fails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still answers with the refusal, logs the failure and leaves no unhandled rejection', async () => {
    vi.spyOn(couponEvents, 'recordCouponRefused').mockRejectedValue(new Error('log store unreachable'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.fn();
    try {
      const plan = { id: 'plan_1', applicationId: 'app_1', slug: 'pack', amount: 1000, currency: 'USD' } as PricedPlan;
      expect(() =>
        resolveCheckoutDiscount({
          plan,
          provider: 'stripe',
          isOneTime: true,
          coupon: { couponId: 'cpn_1', code: 'big', discountAmount: 1000 },
          endUserId: 'eu_1',
          log: { warn },
        }),
      ).toThrowError(expect.objectContaining({ code: 'COUPON_FULL_DISCOUNT_UNSUPPORTED' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toBe('billing log: coupon refusal not recorded');
  });
});
