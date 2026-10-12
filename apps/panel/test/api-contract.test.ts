/**
 * The shapes the panel reads, parsed through the API's own schemas.
 *
 * `api.ts` is typed by hand, so the compiler cannot see the API change a
 * response. Each fixture here is what the panel is written against. It has to
 * parse through the real Zod schema from `@rekey.dev/shared-types`, and the
 * panel's own helpers then have to read the parsed value.
 */

import { describe, expect, it } from 'vitest';
import { CouponWithStatsDtoSchema, CreateCouponRequestSchema, PlanDtoSchema, UpdateCouponRequestSchema } from '@rekey.dev/shared-types';
import type { CouponRow, PlanRow } from '@/lib/api';
import { coverageOf, discountText, readCouponTerms } from '@/lib/coupon-form';
import { additionalPricesOf, amountLockReason, defaultPriceOf, planPriceText, removalLockReason } from '@/lib/plan-prices';
import { grantPlanOptions } from '@/lib/grant-currencies';

const PLAN = {
  id: 'plan_1',
  applicationId: 'app_1',
  slug: 'pro',
  name: 'Pro',
  kind: 'SUBSCRIPTION',
  interval: 'MONTH',
  isFree: false,
  trialDays: null,
  licenseKind: null,
  licenseSeatsAllowed: null,
  licenseDurationDays: null,
  meterSlug: null,
  creditsAmount: null,
  price: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'default', requestedCurrency: null },
  prices: [
    {
      id: 'pp_usd',
      currency: 'USD',
      amount: 1900,
      countries: [],
      isDefault: true,
      archived: false,
      registration: { status: 'REGISTERED', error: null },
      amountEditable: false,
      liveSubscriptions: 3,
      openCheckouts: 0,
    },
    {
      id: 'pp_inr',
      currency: 'INR',
      amount: 149900,
      countries: ['IN'],
      isDefault: false,
      archived: false,
      registration: { status: 'FAILED', error: 'Amount below the minimum' },
      amountEditable: true,
      liveSubscriptions: 0,
      openCheckouts: 1,
    },
  ],
  defaultPriceId: 'pp_usd',
  localPrices: 'INHERIT',
  active: true,
  registrationStatus: 'REGISTERED',
  registrationError: null,
  metadata: {},
  createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z',
  checkout: {
    ready: false,
    blockers: [{ provider: 'stripe', code: 'PLAN_NOT_REGISTERED', message: 'Not registered.', fix: 'Register it.' }],
  },
} as const;

describe('a plan', () => {
  it('parses through PlanDtoSchema and reads as the panel reads it', () => {
    const plan = PlanDtoSchema.parse(PLAN) as PlanRow;
    expect(defaultPriceOf(plan)?.id).toBe(plan.defaultPriceId);
    expect(additionalPricesOf(plan).map((price) => price.currency)).toEqual(['INR']);
    expect(planPriceText(plan)).toBe('$19.00');
    expect(plan.prices[1]?.registration).toEqual({ status: 'FAILED', error: 'Amount below the minimum' });
    expect(plan.checkout?.blockers[0]?.fix).toBe('Register it.');
    // The reasons shown on a price's controls are read from what the API says about it.
    expect(amountLockReason(plan.prices[0]!)).toContain('A payment provider holds this price');
    expect(amountLockReason(plan.prices[1]!)).toBeNull();
    expect(removalLockReason(plan.prices[1]!)).toBe('1 open checkout is on this price. It can be removed once it has completed or expired.');
    expect(grantPlanOptions([plan])[0]).toEqual({
      slug: 'pro',
      label: 'Pro ($19.00 / month)',
      prices: [
        { currency: 'USD', price: '$19.00' },
        { currency: 'INR', price: '₹1,499.00' },
      ],
    });
  });

  it('with no flat price has no default price row, and says free or no base fee', () => {
    const free = PlanDtoSchema.parse({ ...PLAN, isFree: true, price: null, prices: [], defaultPriceId: null }) as PlanRow;
    expect(defaultPriceOf(free)).toBeNull();
    expect(planPriceText(free)).toBe('Free');
    const usage = PlanDtoSchema.parse({
      ...PLAN,
      kind: 'USAGE',
      price: null,
      prices: [],
      defaultPriceId: null,
      meterSlug: 'api_calls',
    }) as PlanRow;
    expect(planPriceText(usage)).toBe('No base fee');
  });
});

const COUPON = {
  id: 'cpn_1',
  applicationId: 'app_1',
  code: 'five',
  discountType: 'AMOUNT',
  basisPoints: null,
  amounts: [
    { currency: 'INR', amountOff: 40000 },
    { currency: 'USD', amountOff: 500 },
  ],
  currencies: [],
  coveredCurrencies: ['INR', 'USD'],
  planSlugs: [],
  active: true,
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  maxRedemptionsPerUser: 1,
  metadata: {},
  createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z',
  redemptionCount: 4,
  discountIssuedByCurrency: [
    { currency: 'USD', amount: 1500, redemptions: 3 },
    { currency: 'INR', amount: 40000, redemptions: 1 },
  ],
} as const;

describe('a coupon', () => {
  it('parses through CouponWithStatsDtoSchema and reads as the panel reads it', () => {
    const coupon = CouponWithStatsDtoSchema.parse(COUPON) as CouponRow;
    expect(discountText(coupon)).toBe('₹400.00, $5.00');
    const plans = [{ slug: 'pro', active: true, currencies: ['USD', 'EUR'] }];
    expect(coverageOf(coupon, plans, 'USD')).toEqual({ label: 'INR, USD', refusedIn: ['EUR'] });
    expect(coupon.discountIssuedByCurrency.map((issued) => issued.currency)).toEqual(['USD', 'INR']);
  });

  it('what the form sends parses through the create and update request schemas', () => {
    const data = new FormData();
    data.set('amount.USD', '5');
    data.set('amount.INR', '400');
    const read = readCouponTerms('AMOUNT', data);
    if (!read.ok) throw new Error(read.code);
    expect(CreateCouponRequestSchema.parse({ code: 'FIVE', discountType: 'AMOUNT', ...read.terms })).toMatchObject({
      amounts: [
        { currency: 'INR', amountOff: 40000 },
        { currency: 'USD', amountOff: 500 },
      ],
    });
    const percent = new FormData();
    percent.set('percent', '12.5');
    const readPercent = readCouponTerms('PERCENT', percent);
    if (!readPercent.ok) throw new Error(readPercent.code);
    expect(UpdateCouponRequestSchema.parse({ ...readPercent.terms, planSlugs: [] })).toMatchObject({ basisPoints: 1250 });
  });
});
