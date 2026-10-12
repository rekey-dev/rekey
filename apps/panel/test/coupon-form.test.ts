/**
 * The coupon form: a percentage typed as a percentage and sent as basis
 * points, one fixed amount per currency sent in that currency's smallest
 * unit, and which of the plans' currencies a coupon leaves out.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  basisPointsToPercentText,
  coverageOf,
  currenciesInScope,
  discountText,
  percentToBasisPoints,
  readCouponLimits,
  readCouponPlans,
  readCouponTerms,
  uncoveredCurrencies,
  type PlanCurrencies,
} from '@/lib/coupon-form';

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}
const calls: Call[] = [];

class FakePanelApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
vi.mock('@/lib/api', () => ({
  PanelApiError: FakePanelApiError,
  errorQuery: async (_err: unknown, flags: Record<string, string>) => new URLSearchParams(flags).toString(),
  api: async (call: Call) => {
    calls.push(call);
    return {};
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { createCoupon, updateCouponTerms } = await import('@/app/(authed)/applications/[id]/coupons/actions');

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) data.append(name, entry);
  }
  return data;
}

async function redirectOf(run: () => Promise<void>): Promise<URLSearchParams> {
  const message = await run().then(
    () => '',
    (err: Error) => err.message,
  );
  return new URLSearchParams(message.split('?')[1] ?? '');
}

const PLANS: PlanCurrencies[] = [
  { slug: 'pro', active: true, currencies: ['USD', 'INR'] },
  { slug: 'team', active: true, currencies: ['USD', 'EUR'] },
  { slug: 'old', active: false, currencies: ['GBP'] },
  { slug: 'free', active: true, currencies: [] },
];

describe('percentToBasisPoints', () => {
  it.each([
    ['15', 1500],
    ['12.5', 1250],
    ['0.15', 15],
    ['100', 10000],
    [' 7.25 ', 725],
  ])('reads %j as %i basis points', (typed, basisPoints) => {
    expect(percentToBasisPoints(typed)).toBe(basisPoints);
  });

  it.each(['', '0', '100.01', '1500', '12.345', '-5', '5%', 'ten'])('refuses %j', (typed) => {
    expect(percentToBasisPoints(typed)).toBeNull();
  });

  it('round-trips what the edit form prefills', () => {
    for (const basisPoints of [1, 15, 100, 1250, 1500, 10000]) {
      expect(percentToBasisPoints(basisPointsToPercentText(basisPoints))).toBe(basisPoints);
    }
    expect(basisPointsToPercentText(1250)).toBe('12.5');
    expect(basisPointsToPercentText(15)).toBe('0.15');
  });
});

describe('readCouponTerms', () => {
  it('sends a percentage as basis points with its currency limit', () => {
    expect(readCouponTerms('PERCENT', form({ percent: '15', currencies: ['usd', 'EUR'] }))).toEqual({
      ok: true,
      terms: { basisPoints: 1500, currencies: ['EUR', 'USD'] },
    });
  });

  it('sends each fixed amount in its own smallest unit', () => {
    const read = readCouponTerms('AMOUNT', form({ 'amount.USD': '5', 'amount.JPY': '500', 'amount.HUF': '1500', 'amount.INR': '' }));
    expect(read).toEqual({
      ok: true,
      terms: {
        amounts: [
          { currency: 'HUF', amountOff: 150000 },
          { currency: 'JPY', amountOff: 500 },
          { currency: 'USD', amountOff: 500 },
        ],
      },
    });
  });

  it('takes a currency the operator added, and refuses it twice', () => {
    expect(readCouponTerms('AMOUNT', form({ extraCurrency: 'eur', extraAmount: '4.50' }))).toEqual({
      ok: true,
      terms: { amounts: [{ currency: 'EUR', amountOff: 450 }] },
    });
    expect(readCouponTerms('AMOUNT', form({ 'amount.EUR': '5', extraCurrency: 'EUR', extraAmount: '4' }))).toEqual({
      ok: false,
      code: 'duplicate',
    });
  });

  it.each([
    [{ 'amount.JPY': '5.5' }, 'amount'],
    [{ 'amount.HUF': '1500.50' }, 'amount'],
    [{ 'amount.USD': '5.999' }, 'amount'],
    [{ extraCurrency: 'KWD', extraAmount: '1.500' }, 'currency'],
    [{ extraCurrency: 'EUR', extraAmount: '' }, 'amount'],
    [{ 'amount.USD': '' }, 'COUPON_AMOUNTS_REQUIRED'],
  ])('refuses %j with %s', (fields, code) => {
    expect(readCouponTerms('AMOUNT', form(fields))).toEqual({ ok: false, code });
  });

  it('refuses a percentage outside 0.01 to 100 and a limit to a currency nobody sells in', () => {
    expect(readCouponTerms('PERCENT', form({ percent: '150' }))).toEqual({ ok: false, code: 'percent' });
    expect(readCouponTerms('PERCENT', form({ percent: '15', currencies: 'KWD' }))).toEqual({ ok: false, code: 'currency' });
  });
});

describe('coverage', () => {
  it('scopes to every active plan, or to the plans the coupon names', () => {
    expect(currenciesInScope(PLANS, [], 'USD')).toEqual(['USD', 'EUR', 'INR']);
    expect(currenciesInScope(PLANS, ['pro'], 'INR')).toEqual(['INR', 'USD']);
    expect(currenciesInScope(PLANS, ['old'])).toEqual(['GBP']);
  });

  it('names the plan currencies a coupon is refused in', () => {
    expect(uncoveredCurrencies(['USD'], ['USD', 'EUR', 'INR'])).toEqual(['EUR', 'INR']);
    expect(uncoveredCurrencies(null, ['USD', 'INR'])).toEqual([]);
    expect(coverageOf({ coveredCurrencies: ['USD'], planSlugs: ['pro'] }, PLANS, 'USD')).toEqual({
      label: 'USD',
      refusedIn: ['INR'],
    });
    expect(coverageOf({ coveredCurrencies: null, planSlugs: [] }, PLANS).label).toBe('Any currency');
  });

  it('writes the discount without adding currencies together', () => {
    expect(discountText({ discountType: 'PERCENT', basisPoints: 1250, amounts: [] })).toBe('12.5%');
    expect(
      discountText({
        discountType: 'AMOUNT',
        basisPoints: null,
        amounts: [
          { currency: 'USD', amountOff: 500 },
          { currency: 'JPY', amountOff: 500 },
        ],
      }),
    ).toBe('$5.00, ¥500');
  });
});

describe('the coupon actions', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('creates a fixed coupon with one amount per currency, converted once', async () => {
    const landed = await redirectOf(() =>
      createCoupon(
        'app_1',
        form({ code: 'FIVE', discountType: 'AMOUNT', 'amount.USD': '5.00', 'amount.JPY': '500', 'amount.HUF': '1500', planSlugs: ['pro'] }),
      ),
    );
    expect(landed.get('created')).toBe('FIVE');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      code: 'FIVE',
      discountType: 'AMOUNT',
      amounts: [
        { currency: 'HUF', amountOff: 150000 },
        { currency: 'JPY', amountOff: 500 },
        { currency: 'USD', amountOff: 500 },
      ],
      planSlugs: ['pro'],
    });
    // A hundredfold slip in either direction would read 50000 or 5 for USD.
    const usd = (calls[0]?.body?.amounts as Array<{ currency: string; amountOff: number }>).find((a) => a.currency === 'USD');
    expect(usd?.amountOff).not.toBe(50000);
    expect(usd?.amountOff).not.toBe(5);
  });

  it('never sends the removed single amount and currency fields', async () => {
    await redirectOf(() => createCoupon('app_1', form({ code: 'TEN', discountType: 'PERCENT', percent: '10' })));
    expect(calls[0]?.body).toEqual({ code: 'TEN', discountType: 'PERCENT', basisPoints: 1000, currencies: [] });
    expect(calls[0]?.body).not.toHaveProperty('amountOff');
    expect(calls[0]?.body).not.toHaveProperty('currency');
  });

  it('sends nothing when an amount cannot be charged in its currency', async () => {
    const landed = await redirectOf(() =>
      createCoupon('app_1', form({ code: 'BAD', discountType: 'AMOUNT', extraCurrency: 'KWD', extraAmount: '1.500' })),
    );
    expect(calls).toHaveLength(0);
    expect(landed.get('error')).toBe('currency');
    expect(landed.get('newCoupon')).toBe('1');
  });

  it('an edit replaces the whole set of amounts and the plan scope', async () => {
    const landed = await redirectOf(() =>
      updateCouponTerms('app_1', { code: 'five', discountType: 'AMOUNT' }, form({ 'amount.USD': '7', 'amount.INR': '' })),
    );
    expect(landed.get('saved')).toBe('five');
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/tenant/applications/app_1/coupons/five',
      body: { amounts: [{ currency: 'USD', amountOff: 700 }], planSlugs: [] },
    });
  });

  it('a refused edit reopens that coupon and sends nothing', async () => {
    const landed = await redirectOf(() =>
      updateCouponTerms('app_1', { code: 'ten', discountType: 'PERCENT' }, form({ percent: '0' })),
    );
    expect(calls).toHaveLength(0);
    expect(landed.get('editCoupon')).toBe('ten');
    expect(landed.get('editError')).toBe('percent');
  });

  it('an edit sends the end date and both caps, and null for one left empty', async () => {
    await redirectOf(() =>
      updateCouponTerms(
        'app_1',
        { code: 'ten', discountType: 'PERCENT' },
        form({ percent: '10', endsAt: '2026-12-31T18:29:00.000Z', maxRedemptions: '500', maxRedemptionsPerUser: '' }),
      ),
    );
    expect(calls[0]?.body).toEqual({
      basisPoints: 1000,
      currencies: [],
      planSlugs: [],
      endsAt: '2026-12-31T18:29:00.000Z',
      maxRedemptions: 500,
      maxRedemptionsPerUser: null,
    });

    calls.length = 0;
    await redirectOf(() => updateCouponTerms('app_1', { code: 'ten', discountType: 'PERCENT' }, form({ percent: '10' })));
    expect(calls[0]?.body).toMatchObject({ endsAt: null, maxRedemptions: null, maxRedemptionsPerUser: null });
  });

  it.each([
    [{ maxRedemptions: '0' }, 'limit'],
    [{ maxRedemptions: '2.5' }, 'limit'],
    [{ maxRedemptionsPerUser: '-1' }, 'limit'],
    [{ maxRedemptions: '2147483648' }, 'limit'],
    [{ endsAt: 'soon' }, 'endsAt'],
  ])('an edit with %j reopens the coupon with "%s" and sends nothing', async (fields, code) => {
    const landed = await redirectOf(() =>
      updateCouponTerms('app_1', { code: 'ten', discountType: 'PERCENT' }, form({ percent: '10', ...fields })),
    );
    expect(calls).toHaveLength(0);
    expect(landed.get('editCoupon')).toBe('ten');
    expect(landed.get('editError')).toBe(code);
  });

  it('a create leaves an empty limit out, and sends the ones given', async () => {
    await redirectOf(() =>
      createCoupon('app_1', form({ code: 'TEN', discountType: 'PERCENT', percent: '10', endsAt: '2026-12-31T18:29:00.000Z', maxRedemptions: '', maxRedemptionsPerUser: '2' })),
    );
    expect(calls[0]?.body).toEqual({
      code: 'TEN',
      discountType: 'PERCENT',
      basisPoints: 1000,
      currencies: [],
      endsAt: '2026-12-31T18:29:00.000Z',
      maxRedemptionsPerUser: 2,
    });
  });

  it('reads an empty limit as none, and keeps the instant the browser sent', () => {
    expect(readCouponLimits(form({}))).toEqual({ ok: true, limits: { endsAt: null, maxRedemptions: null, maxRedemptionsPerUser: null } });
    expect(readCouponLimits(form({ endsAt: '2026-12-31T18:29:00.000Z', maxRedemptions: ' 7 ' }))).toEqual({
      ok: true,
      limits: { endsAt: '2026-12-31T18:29:00.000Z', maxRedemptions: 7, maxRedemptionsPerUser: null },
    });
  });

  it('reads the ticked plans', () => {
    expect(readCouponPlans(form({ planSlugs: ['Pro', 'team', 'pro'] }))).toEqual(['pro', 'team']);
  });
});
