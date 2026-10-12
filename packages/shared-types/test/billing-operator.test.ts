import { describe, expect, it } from 'vitest';
import {
  BILLING_EVENT_DATA,
  BILLING_MONEY_ERROR_CODES,
  BillingProviderInfoDtoSchema,
  CheckoutResultDtoSchema,
  CreateRefundRequestSchema,
  ProvidersListDtoSchema,
  REFUND_BLOCKED_REASONS,
  RefundResultDtoSchema,
  RekeyError,
  SetPlanPriceRequestSchema,
  TenantPaymentDtoSchema,
  CreatePlanRequestSchema,
  PlanDtoSchema,
  PlanPriceDtoSchema,
  PublicPlanDtoSchema,
  PublicPlanPriceDtoSchema,
  UpdateCouponRequestSchema,
  UpdatePlanRequestSchema,
  isBillingMoneyError,
  priceFallbackMessage,
  refundBlockedMessage,
} from '../src/index.js';
import { priceFallbackMessage as fromSubpath } from '../src/currency/index.js';

const REFUND = {
  id: 'rf_1',
  paymentId: 'pay_1',
  providerRefundId: 're_1',
  amount: 500,
  currency: 'USD',
  status: 'succeeded',
  reason: null,
  initiatedBy: 'operator',
  createdAt: '2026-10-12T09:00:00.000Z',
};

describe('refund shapes', () => {
  it('parses what issuing a refund answers', () => {
    const parsed = RefundResultDtoSchema.parse({
      refund: REFUND,
      payment: { id: 'pay_1', amount: 1900, currency: 'USD', refundedAmount: 500, status: 'PARTIALLY_REFUNDED' },
    });
    expect(parsed.payment.refundedAmount).toBe(500);
  });

  it('refuses a refund status the API never sends', () => {
    expect(RefundResultDtoSchema.safeParse({ refund: { ...REFUND, status: 'SUCCEEDED' }, payment: {} }).success).toBe(false);
  });

  it('refuses a refund request with an unknown key, a zero amount or a fraction', () => {
    expect(CreateRefundRequestSchema.safeParse({}).success).toBe(true);
    expect(CreateRefundRequestSchema.safeParse({ amount: 0 }).success).toBe(false);
    expect(CreateRefundRequestSchema.safeParse({ amount: 1.5 }).success).toBe(false);
    expect(CreateRefundRequestSchema.safeParse({ currency: 'USD' }).success).toBe(false);
  });
});

describe('SetPlanPriceRequestSchema', () => {
  it('takes countries alone, for a price that exists', () => {
    expect(SetPlanPriceRequestSchema.parse({ countries: ['IN'] })).toEqual({ countries: ['IN'] });
  });

  it('refuses a currency in the body: it is the path', () => {
    expect(SetPlanPriceRequestSchema.safeParse({ amount: 100, currency: 'INR' }).success).toBe(false);
  });
});

describe('a plan and its default price', () => {
  const REMOVED = ['amount', 'currency', 'pricePerUnitCents'];

  it('has no amount, currency or per-unit price of its own in the operator schema', () => {
    for (const field of REMOVED) expect(Object.keys(PlanDtoSchema.shape), field).not.toContain(field);
    for (const field of ['price', 'prices', 'defaultPriceId', 'isFree']) expect(Object.keys(PlanDtoSchema.shape), field).toContain(field);
  });

  it('is created and changed with `price`, both fields together, or null on a change to make it free', () => {
    for (const field of REMOVED) {
      expect(Object.keys(CreatePlanRequestSchema.shape), field).not.toContain(field);
      expect(Object.keys(UpdatePlanRequestSchema.shape), field).not.toContain(field);
    }
    expect(CreatePlanRequestSchema.parse({ slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 } }).price).toEqual({ currency: 'USD', amount: 1900 });
    expect(CreatePlanRequestSchema.parse({ slug: 'free', name: 'Free' }).price).toBeUndefined();
    expect(UpdatePlanRequestSchema.parse({ price: null }).price).toBeNull();
    expect(CreatePlanRequestSchema.safeParse({ slug: 'pro', name: 'Pro', price: { amount: 1900 } }).success).toBe(false);
    expect(CreatePlanRequestSchema.safeParse({ slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 0 } }).success).toBe(false);
    expect(CreatePlanRequestSchema.safeParse({ slug: 'pro', name: 'Pro', price: null }).success).toBe(false);
  });

  it('takes the local prices rule on a change, in the spelling the plan returns', () => {
    for (const rule of PlanDtoSchema.shape.localPrices.options) {
      expect(UpdatePlanRequestSchema.parse({ localPrices: rule }).localPrices).toBe(rule);
    }
    expect(UpdatePlanRequestSchema.safeParse({ localPrices: 'off' }).success).toBe(false);
  });
});

describe('what an operator is told about a price', () => {
  const FACTS = ['amountEditable', 'liveSubscriptions', 'openCheckouts'];
  const price = { id: 'pp_1', currency: 'INR', amount: 149900, countries: [], isDefault: false, archived: false };

  it('is required on the operator price: whether the amount can change, and who is on it', () => {
    const full = { ...price, registration: { status: 'REGISTERED', error: null }, amountEditable: false, liveSubscriptions: 3, openCheckouts: 1 };
    expect(PlanPriceDtoSchema.parse(full)).toEqual(full);
    for (const fact of FACTS) {
      const { [fact]: _left, ...without } = full as Record<string, unknown>;
      expect(PlanPriceDtoSchema.safeParse(without).success, fact).toBe(false);
    }
  });

  it('is not part of the public price', () => {
    expect(Object.keys(PublicPlanPriceDtoSchema.shape).sort()).toEqual(['amount', 'archived', 'countries', 'currency', 'id', 'isDefault']);
    for (const fact of FACTS) expect(Object.keys(PublicPlanPriceDtoSchema.shape), fact).not.toContain(fact);
    // The public plan is built from the public price, not the operator's.
    expect(PublicPlanDtoSchema.shape.prices.element).toBe(PublicPlanPriceDtoSchema);
  });
});

describe('fields that were optional for an older API', () => {
  const subscription = {
    id: 'sub_1',
    applicationId: 'app_1',
    endUserId: 'eu_1',
    planId: 'plan_1',
    status: 'PENDING',
    currentPeriodEnd: null,
    cancelAt: null,
    canceledAt: null,
    provider: 'stripe',
    providerSubId: null,
    metadata: {},
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    beneficiaryOrgId: null,
    trialEndsAt: null,
    price: null,
  };
  const checkout = {
    url: 'https://checkout.example/c/1',
    subscription,
    discountAmount: 0,
    currency: 'USD',
    unitAmount: 1900,
    price: { id: 'pp_1', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'default', requestedCurrency: null },
    priceFallback: null,
    provider: 'stripe',
    warnings: [],
    mode: 'redirect',
    checkoutSessionId: 'cs_1',
  };

  it('a checkout result parses whole', () => {
    expect(CheckoutResultDtoSchema.parse(checkout).currency).toBe('USD');
  });

  it.each(['currency', 'unitAmount', 'warnings', 'mode', 'checkoutSessionId', 'price', 'priceFallback'])(
    'a checkout result without %s is refused',
    (field) => {
      const { [field as keyof typeof checkout]: _dropped, ...rest } = checkout;
      expect(CheckoutResultDtoSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('a provider row must say which currencies it charges', () => {
    expect(BillingProviderInfoDtoSchema.safeParse({ provider: 'stripe', priority: 0, countries: [] }).success).toBe(false);
    expect(BillingProviderInfoDtoSchema.safeParse({ provider: 'stripe', priority: 0, countries: [], currencies: [] }).success).toBe(true);
  });

  it('a provider list must carry countrySource and routedProvider', () => {
    expect(ProvidersListDtoSchema.safeParse({ country: null, providers: [] }).success).toBe(false);
    expect(
      ProvidersListDtoSchema.safeParse({ country: null, countrySource: null, routedProvider: null, providers: [] }).success,
    ).toBe(true);
  });

  it('an operator payment row carries its refunded total, its provider and whether it can be refunded', () => {
    const row = {
      id: 'pay_1',
      endUserId: null,
      subscriptionId: null,
      amount: 1900,
      currency: 'USD',
      status: 'SUCCEEDED',
      providerPaymentId: null,
      description: null,
      createdAt: '2026-10-12T09:00:00.000Z',
      endUserEmail: null,
    };
    expect(TenantPaymentDtoSchema.safeParse(row).success).toBe(false);
    const money = { ...row, refundedAmount: 0, verification: 'verified' };
    expect(TenantPaymentDtoSchema.safeParse(money).success).toBe(false);
    const whole = { ...money, provider: 'stripe', refundable: true, refundBlockedReason: null };
    expect(TenantPaymentDtoSchema.parse(whole).refundedAmount).toBe(0);
    expect(TenantPaymentDtoSchema.safeParse({ ...whole, refundBlockedReason: 'too_old' }).success).toBe(false);
  });

  it('every refund blocked reason has a sentence for a person', () => {
    for (const reason of REFUND_BLOCKED_REASONS) {
      expect(TenantPaymentDtoSchema.safeParse({
        id: 'pay_1', endUserId: null, subscriptionId: null, amount: 1900, currency: 'USD', status: 'SUCCEEDED',
        refundedAmount: 0, verification: 'verified', provider: null, refundable: false, refundBlockedReason: reason,
        providerPaymentId: null, description: null, createdAt: '2026-10-12T09:00:00.000Z', endUserEmail: null,
      }).success, reason).toBe(true);
      expect(refundBlockedMessage(reason)).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe('a coupon edit', () => {
  it('takes an end date and caps, each a value or null, and refuses a cap that is not a whole number of 1 or more', () => {
    expect(UpdateCouponRequestSchema.parse({ endsAt: '2026-12-31T23:59:59.000Z', maxRedemptions: 500, maxRedemptionsPerUser: null })).toEqual({
      endsAt: '2026-12-31T23:59:59.000Z',
      maxRedemptions: 500,
      maxRedemptionsPerUser: null,
    });
    expect(UpdateCouponRequestSchema.safeParse({ endsAt: null }).success).toBe(true);
    for (const body of [{ maxRedemptions: 0 }, { maxRedemptionsPerUser: 1.5 }, { maxRedemptions: 2_147_483_648 }, { endsAt: '2026-12-31' }, {}]) {
      expect(UpdateCouponRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('is logged with the end date and caps, and an entry written before they were logged is still valid', () => {
    const before = { active: true, basisPoints: 1500, amounts: [], currencies: [], planSlugs: [] };
    const changed = BILLING_EVENT_DATA['coupon.changed'];
    expect(changed.safeParse({ code: 'launch', discountType: 'PERCENT', before, after: { ...before, active: false } }).success).toBe(true);
    const limits = { endsAt: '2026-12-31T23:59:59.000Z', maxRedemptions: 500, maxRedemptionsPerUser: null };
    expect(changed.safeParse({ code: 'launch', discountType: 'PERCENT', before: { ...before, endsAt: null, maxRedemptions: null, maxRedemptionsPerUser: null }, after: { ...before, ...limits } }).success).toBe(true);
    expect(changed.safeParse({ code: 'launch', discountType: 'PERCENT', before, after: { ...before, maxRedemptions: 0 } }).success).toBe(false);
    expect(BILLING_MONEY_ERROR_CODES).toContain('COUPON_LIMIT_BELOW_REDEEMED');
  });
});

describe('priceFallbackMessage', () => {
  it('names the currency that could not be charged and the price that will be', () => {
    expect(priceFallbackMessage({ requested: { currency: 'inr' }, charged: { formatted: '$19.00' } })).toBe(
      'Prices in INR are not available yet. You will pay $19.00.',
    );
  });

  it('is the same function on the zod-free currency subpath', () => {
    expect(fromSubpath).toBe(priceFallbackMessage);
  });
});

describe('isBillingMoneyError', () => {
  it('matches a RekeyError carrying a listed code and narrows it', () => {
    const err: unknown = new RekeyError({ code: 'COUPON_CURRENCY_NOT_COVERED', message: 'This code does not work for prices in INR.' });
    expect(isBillingMoneyError(err)).toBe(true);
    if (isBillingMoneyError(err)) expect(err.code).toBe('COUPON_CURRENCY_NOT_COVERED');
  });

  it('does not match another code, or a value that is not an error', () => {
    expect(isBillingMoneyError(new RekeyError({ code: 'PLAN_NOT_FOUND', message: 'x' }))).toBe(false);
    expect(isBillingMoneyError(null)).toBe(false);
    expect(isBillingMoneyError('BILLING_FIELD_REMOVED')).toBe(false);
  });

  it('lists each code once, and neither code the money model removed', () => {
    expect(new Set(BILLING_MONEY_ERROR_CODES).size).toBe(BILLING_MONEY_ERROR_CODES.length);
    expect(BILLING_MONEY_ERROR_CODES).not.toContain('COUPON_CURRENCY_MISMATCH');
    expect(BILLING_MONEY_ERROR_CODES).not.toContain('COUPON_CURRENCY_REQUIRED');
  });
});
