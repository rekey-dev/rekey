/**
 * The one discount function, the columns kept for the previous build, the
 * basis-points backfill, and rows an earlier build wrote.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  computeDiscount,
  couponTermsFor,
  previousBuildColumns,
  type CouponRecord,
} from '../src/modules/coupons/coupon-terms.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

const BACKFILL = new URL(
  '../../../prisma/migrations/20261011100041_money_v2_41_backfill_coupon_basis_points/migration.sql',
  import.meta.url,
);

function percent(basisPoints: number | null, currencies: string[] = []): CouponRecord {
  return { discountType: 'PERCENT', basisPoints, currencies, amounts: [], amountOff: 999_999, currency: 'USD' } as unknown as CouponRecord;
}
function fixed(amounts: Record<string, number>): CouponRecord {
  return {
    discountType: 'AMOUNT',
    basisPoints: null,
    currencies: [],
    // The columns the previous build read hold values that would be wrong
    // anywhere, so a result that came from them shows.
    amountOff: 999_999,
    currency: 'USD',
    amounts: Object.entries(amounts).map(([currency, amountOff]) => ({ currency, amountOff })),
  } as unknown as CouponRecord;
}

describe('computeDiscount', () => {
  it.each([
    // 15% of 19.99 is 2.9985: three dollars, toward the buyer.
    ['USD', 1999, 1500, 300],
    ['USD', 1000, 1500, 150],
    // The yen has no subunit: 15% of ¥1,999 is ¥299.85, so ¥300.
    ['JPY', 1999, 1500, 300],
    ['JPY', 2000, 1500, 300],
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

  it('takes nothing for a percentage with no rate, whatever the old column holds', () => {
    expect(computeDiscount(percent(null), 1999, 'USD')).toBe(0);
    expect(computeDiscount(percent(0), 1999, 'USD')).toBe(0);
  });
});

describe('the columns the previous build reads', () => {
  const columns = (type: 'PERCENT' | 'AMOUNT', input: Parameters<typeof couponTermsFor>[1]) =>
    previousBuildColumns(type, couponTermsFor(type, input));

  it('carry a coupon that build judges correctly', () => {
    expect(columns('PERCENT', { basisPoints: 1500 })).toEqual({ amountOff: 1500, currency: null });
    expect(columns('AMOUNT', { amounts: [{ currency: 'inr', amountOff: 40000 }] })).toEqual({ amountOff: 40000, currency: 'INR' });
  });

  it('carry nothing it could apply for a coupon it would misjudge', () => {
    // It knows no per-currency amounts and no currency limit, so it must refuse.
    expect(columns('AMOUNT', { amounts: [{ currency: 'USD', amountOff: 500 }, { currency: 'INR', amountOff: 40000 }] })).toEqual({ amountOff: 0, currency: null });
    expect(columns('PERCENT', { basisPoints: 1500, currencies: ['USD'] })).toEqual({ amountOff: 0, currency: null });
  });
});

describe('coupon rows an earlier build wrote', () => {
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
  const seed = (data: { code: string; discountType: 'PERCENT' | 'AMOUNT'; amountOff: number; currency?: string; basisPoints?: number }) =>
    prisma.coupon.create({ data: { applicationId: w.applicationId, ...data } });

  it('does not read the old amount: a fixed coupon with no amount row is not covered, here and at checkout', async () => {
    await seed({ code: 'oldfixed', discountType: 'AMOUNT', amountOff: 500, currency: 'USD' });
    const quoted = await preview('OLDFIXED');
    expect(quoted.statusCode).toBe(400);
    expect(quoted.json().error.code).toBe('COUPON_CURRENCY_NOT_COVERED');
    expect((await w.checkout({ couponCode: 'OLDFIXED' })).json().error.code).toBe('COUPON_CURRENCY_NOT_COVERED');

    const read = (await w.operator('GET', '/coupons/oldfixed')).json().data as Record<string, unknown>;
    expect(read).toMatchObject({ amounts: [], coveredCurrencies: [] });
    expect(read).not.toHaveProperty('amountOff');
    expect(read).not.toHaveProperty('currency');
  });

  it('takes the amount row over a different old amount', async () => {
    const coupon = await seed({ code: 'drifted', discountType: 'AMOUNT', amountOff: 500, currency: 'USD' });
    await prisma.couponAmount.create({ data: { couponId: coupon.id, applicationId: w.applicationId, currency: 'USD', amountOff: 700 } });
    expect((await preview('DRIFTED')).json().data).toMatchObject({ currency: 'USD', discountAmount: 700 });
  });

  it('refuses a percentage with no rate as worth nothing, here and at checkout, and the fix it names works', async () => {
    await seed({ code: 'oldpct', discountType: 'PERCENT', amountOff: 1500 });
    const quoted = await preview('OLDPCT');
    expect(quoted.statusCode).toBe(400);
    expect(quoted.json().error.code).toBe('COUPON_NO_DISCOUNT');
    expect(quoted.json().error.fix).toContain('`basisPoints` from 1 to 10000 to PATCH');
    expect((await w.checkout({ couponCode: 'OLDPCT' })).json().error.code).toBe('COUPON_NO_DISCOUNT');
    expect(await prisma.couponRedemption.count({ where: { applicationId: w.applicationId } })).toBe(0);

    expect((await w.operator('PATCH', '/coupons/OLDPCT', { basisPoints: 1500 })).statusCode).toBe(200);
    expect((await preview('OLDPCT')).json().data).toMatchObject({ discountAmount: 300 });
  });

  it('can be switched off without a rate or an amount, and keeps the old columns for the backfill', async () => {
    await seed({ code: 'oldpct', discountType: 'PERCENT', amountOff: 1500 });
    await seed({ code: 'oldfixed', discountType: 'AMOUNT', amountOff: 500, currency: 'USD' });
    for (const code of ['oldpct', 'oldfixed']) {
      const res = await w.operator('PATCH', `/coupons/${code}`, { active: false });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ active: false });
      expect((await preview(code)).json().error.code).toBe('COUPON_INACTIVE');
    }
    const rows = await prisma.coupon.findMany({ where: { applicationId: w.applicationId }, orderBy: { code: 'asc' } });
    expect(rows).toMatchObject([
      { code: 'oldfixed', amountOff: 500, currency: 'USD' },
      { code: 'oldpct', amountOff: 1500, basisPoints: null },
    ]);
  });

  describe('the basis-points backfill', () => {
    const statements = readFileSync(BACKFILL, 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((sql) => sql.trim())
      .filter((sql) => sql !== '');
    async function backfill(): Promise<void> {
      for (const sql of statements) await prisma.$executeRawUnsafe(sql);
    }
    const rateOf = async (code: string) =>
      (await prisma.coupon.findFirstOrThrow({ where: { applicationId: w.applicationId, code } })).basisPoints;

    it('copies each percentage once, keeps an edited one, and leaves fixed coupons and impossible rates alone', async () => {
      await seed({ code: 'pct', discountType: 'PERCENT', amountOff: 1500 });
      await seed({ code: 'zero', discountType: 'PERCENT', amountOff: 0 });
      await seed({ code: 'edited', discountType: 'PERCENT', amountOff: 1500, basisPoints: 2500 });
      await seed({ code: 'impossible', discountType: 'PERCENT', amountOff: 15000 });
      await seed({ code: 'fixed', discountType: 'AMOUNT', amountOff: 500, currency: 'USD' });
      expect(statements.length).toBeGreaterThan(0);

      await backfill();
      expect(await rateOf('pct')).toBe(1500);
      expect(await rateOf('zero')).toBe(0);
      expect(await rateOf('edited')).toBe(2500);
      expect(await rateOf('impossible')).toBeNull();
      expect(await rateOf('fixed')).toBeNull();
      // The old column is left as it was.
      expect((await prisma.coupon.findFirstOrThrow({ where: { code: 'pct', applicationId: w.applicationId } })).amountOff).toBe(1500);

      const before = await prisma.coupon.findMany({ orderBy: { id: 'asc' } });
      await backfill();
      expect(await prisma.coupon.findMany({ orderBy: { id: 'asc' } })).toEqual(before);

      // The copied coupon now discounts as it did before the column moved.
      expect((await preview('PCT')).json().data).toMatchObject({ discountAmount: 300 });
    });
  });
});
