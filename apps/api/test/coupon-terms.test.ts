/**
 * The one discount function, and coupons that take nothing off.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  computeDiscount,
  type CouponRecord,
} from '../src/modules/coupons/coupon-terms.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

function percent(basisPoints: number | null, currencies: string[] = []): CouponRecord {
  return { discountType: 'PERCENT', basisPoints, currencies, amounts: [] } as unknown as CouponRecord;
}
function fixed(amounts: Record<string, number>): CouponRecord {
  return {
    discountType: 'AMOUNT',
    basisPoints: null,
    currencies: [],
    amounts: Object.entries(amounts).map(([currency, amountOff]) => ({ currency, amountOff })),
  } as unknown as CouponRecord;
}

describe('computeDiscount', () => {
  it.each([
    // 15% of 19.99 is 2.9985: three dollars, toward the buyer.
    ['USD', 1999, 1500, 300],
    // The yen has no subunit: 15% of ¥1,999 is ¥299.85, so ¥300.
    ['JPY', 1999, 1500, 300],
    // The forint is charged in whole units, stored in hundredths: 15% of Ft 4,990 is Ft 748.5, so Ft 749.
    ['HUF', 499000, 1500, 74900],
    ['TWD', 99900, 3333, 33300],
    ['INR', 149900, 5000, 74950],
    ['USD', 1999, 10000, 1999],
    ['USD', 1, 1, 1],
  ])('takes a percentage of %s %i at %i basis points as %i', (currency, amount, basisPoints, expected) => {
    expect(computeDiscount(percent(basisPoints), amount, currency)).toBe(expected);
  });

  it.each([
    ['USD', 1999, 500],
    ['JPY', 1999, 500],
    ['HUF', 499000, 50000],
    ['INR', 149900, 40000],
  ])('takes the amount stated for %s off a price of %i: %i', (currency, amount, expected) => {
    const coupon = fixed({ USD: 500, JPY: 500, HUF: 50000, INR: 40000 });
    expect(computeDiscount(coupon, amount, currency)).toBe(expected);
    expect(computeDiscount(coupon, amount, currency.toLowerCase())).toBe(expected);
  });

  it('never takes more than the price', () => {
    expect(computeDiscount(fixed({ USD: 5000 }), 1999, 'USD')).toBe(1999);
    expect(computeDiscount(fixed({ JPY: 5000 }), 1999, 'JPY')).toBe(1999);
  });

  it('answers null in a currency the coupon does not cover, and never borrows another currency\'s amount', () => {
    expect(computeDiscount(fixed({ USD: 500 }), 149900, 'INR')).toBeNull();
    expect(computeDiscount(fixed({ USD: 500 }), 1999, 'JPY')).toBeNull();
    expect(computeDiscount(fixed({}), 1999, 'USD')).toBeNull();
    expect(computeDiscount(percent(1500, ['USD']), 149900, 'INR')).toBeNull();
    expect(computeDiscount(percent(1500, ['USD']), 1999, 'usd')).toBe(300);
  });

  it('takes nothing for a percentage of zero', () => {
    expect(computeDiscount(percent(0), 1999, 'USD')).toBe(0);
  });
});

describe('coupons that take nothing off', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  const preview = (code: string) => w.asBuyer('POST', '/coupons/validate', { code, planSlug: 'pro' });
  const seed = (data: { code: string; discountType: 'PERCENT' | 'AMOUNT'; basisPoints?: number }) =>
    prisma.coupon.create({ data: { applicationId: w.applicationId, ...data } });

  it('refuses a percentage of zero as worth nothing, here and at checkout, and the fix it names works', async () => {
    await seed({ code: 'oldpct', discountType: 'PERCENT', basisPoints: 0 });
    const quoted = await preview('OLDPCT');
    expect(quoted.statusCode).toBe(400);
    expect(quoted.json().error.code).toBe('COUPON_NO_DISCOUNT');
    expect(quoted.json().error.fix).toContain('`basisPoints` from 1 to 10000 to PATCH');
    expect((await w.checkout({ couponCode: 'OLDPCT' })).json().error.code).toBe('COUPON_NO_DISCOUNT');
    expect(await prisma.couponRedemption.count({ where: { applicationId: w.applicationId } })).toBe(0);

    expect((await w.operator('PATCH', '/coupons/OLDPCT', { basisPoints: 1500 })).statusCode).toBe(200);
    expect((await preview('OLDPCT')).json().data).toMatchObject({ discountAmount: 300 });
  });

  it('can be switched off while it takes nothing off', async () => {
    await seed({ code: 'zero', discountType: 'PERCENT', basisPoints: 0 });
    await seed({ code: 'noamounts', discountType: 'AMOUNT' });
    for (const code of ['zero', 'noamounts']) {
      const res = await w.operator('PATCH', `/coupons/${code}`, { active: false });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ active: false });
      expect((await preview(code)).json().error.code).toBe('COUPON_INACTIVE');
    }
  });
});
