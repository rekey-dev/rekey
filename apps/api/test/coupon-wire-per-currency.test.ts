/**
 * What each provider is sent for a coupon, per currency, with literal wire
 * values. The discount is worked out by `computeDiscount`, the function the
 * checkout uses, and handed to the real adapter: no provider is ever sent a
 * percentage, and each gets the amount in its own scale.
 *
 * The SDKs and `fetch` are stubbed. Nothing dials a processor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndUser, Plan } from '@prisma/client';
import { RealPaypalProvider } from '../src/modules/billing/providers/paypal.js';
import { RealRazorpayProvider } from '../src/modules/billing/providers/razorpay.js';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import type { CheckoutDiscount, CheckoutSessionInput, PricedPlan } from '../src/modules/billing/providers/types.js';
import { computeDiscount, type CouponRecord } from '../src/modules/coupons/coupon-terms.js';
import { pricedPlanFixture } from './priced-plan-fixture.js';

const stripeStub = vi.hoisted(() => ({ coupons: [] as Record<string, unknown>[], sessions: [] as Record<string, unknown>[] }));

vi.mock('stripe', () => {
  class FakeStripe {
    coupons = {
      create: async (params: Record<string, unknown>) => {
        stripeStub.coupons.push(params);
        return { id: 'co_1' };
      },
      del: async () => ({}),
    };
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          stripeStub.sessions.push(params);
          return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' };
        },
      },
    };
  }
  return { default: FakeStripe };
});

const razorpayStub = vi.hoisted(() => ({ links: [] as Record<string, unknown>[] }));

vi.mock('razorpay', () => {
  class FakeRazorpay {
    paymentLink = {
      create: async (params: Record<string, unknown>) => {
        razorpayStub.links.push(params);
        return { id: 'plink_1', short_url: 'https://rzp.test/i/1' };
      },
    };
  }
  return { default: FakeRazorpay };
});

const endUser = { id: 'eu_1', email: 'buyer@example.com' } as unknown as EndUser;

function plan(currency: string, amount: number, kind: 'SUBSCRIPTION' | 'CREDIT'): PricedPlan {
  return pricedPlanFixture({
    id: 'pl_1',
    applicationId: 'app_1',
    slug: 'pro',
    name: 'Pro',
    amount,
    currency,
    interval: 'MONTH',
    kind,
    metadata: { stripe: { priceId: 'price_1' } },
  } as unknown as Plan);
}

const FIFTEEN_PERCENT = { discountType: 'PERCENT', basisPoints: 1500, currencies: [], amounts: [] } as unknown as CouponRecord;
const FIXED = {
  discountType: 'AMOUNT',
  basisPoints: null,
  currencies: [],
  amounts: [
    { currency: 'USD', amountOff: 500 },
    { currency: 'JPY', amountOff: 500 },
    { currency: 'HUF', amountOff: 50000 },
    { currency: 'INR', amountOff: 40000 },
  ],
} as unknown as CouponRecord;

/** The checkout input for `coupon` on a plan priced `amount` in `currency`, as billing.service builds it. */
function discounted(coupon: CouponRecord, currency: string, amount: number, kind: 'SUBSCRIPTION' | 'CREDIT'): CheckoutSessionInput {
  const priced = plan(currency, amount, kind);
  const discount: CheckoutDiscount = {
    amount: computeDiscount(coupon, priced.amount, priced.currency)!,
    currency: priced.currency,
    couponId: 'cpn_1',
    code: 'code',
  };
  return {
    application: { id: 'app_1', slug: 'app' },
    endUser,
    plan: priced,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
    discount,
  };
}

describe('Stripe is sent the amount as `amount_off`, never a percentage', () => {
  const provider = (): RealStripeProvider => new RealStripeProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x' });
  beforeEach(() => {
    stripeStub.coupons.length = 0;
    stripeStub.sessions.length = 0;
  });

  it.each([
    // 15% of $19.99 is $2.9985: $3.00 off.
    ['a percentage', FIFTEEN_PERCENT, 'USD', 1999, 300],
    // 15% of ¥1,999 is ¥299.85: ¥300 off, and the yen has no decimals at Stripe.
    ['a percentage', FIFTEEN_PERCENT, 'JPY', 1999, 300],
    // 15% of Ft 4,990 is Ft 748.5: Ft 749 off, which Stripe reads in hundredths.
    ['a percentage', FIFTEEN_PERCENT, 'HUF', 499000, 74900],
    ['a fixed amount', FIXED, 'USD', 1999, 500],
    ['a fixed amount', FIXED, 'JPY', 1999, 500],
    ['a fixed amount', FIXED, 'HUF', 499000, 50000],
  ])('%s on a %s price of %i goes out as amount_off %i', async (_kind, coupon, currency, amount, wire) => {
    await provider().createCheckoutSession(discounted(coupon, currency, amount, 'SUBSCRIPTION'));
    expect(stripeStub.coupons).toHaveLength(1);
    expect(stripeStub.coupons[0]).toMatchObject({ amount_off: wire, currency: currency.toLowerCase(), duration: 'once', max_redemptions: 1 });
    expect(stripeStub.coupons[0]).not.toHaveProperty('percent_off');
    expect(stripeStub.sessions[0]).toMatchObject({ discounts: [{ coupon: 'co_1' }] });
  });
});

describe('PayPal is sent a discount line that adds up, in its own decimals', () => {
  let orders: Array<Record<string, unknown>>;
  beforeEach(() => {
    orders = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
        if (url.includes('/v2/checkout/orders')) orders.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return Response.json({ id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] }, { status: 201 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const provider = (): RealPaypalProvider => new RealPaypalProvider({ clientId: 'c', clientSecret: 's', webhookId: 'wh' }, 'test');
  const amountOf = () =>
    (orders[0] as { purchase_units: Array<{ amount: { value: string; currency_code: string; breakdown: { item_total: { value: string }; discount: { value: string } } } }> })
      .purchase_units[0]!.amount;

  it.each([
    ['a percentage', FIFTEEN_PERCENT, 'USD', 1999, '19.99', '3.00', '16.99'],
    // The yen and the forint take no decimals at PayPal.
    ['a percentage', FIFTEEN_PERCENT, 'JPY', 1999, '1999', '300', '1699'],
    ['a percentage', FIFTEEN_PERCENT, 'HUF', 499000, '4990', '749', '4241'],
    ['a fixed amount', FIXED, 'USD', 1999, '19.99', '5.00', '14.99'],
    ['a fixed amount', FIXED, 'JPY', 1999, '1999', '500', '1499'],
    ['a fixed amount', FIXED, 'HUF', 499000, '4990', '500', '4490'],
  ])('%s on a %s price of %i: items %s, discount %s, charged %s', async (_kind, coupon, currency, amount, items, discount, value) => {
    await provider().createOneTimeCheckout(discounted(coupon, currency, amount, 'CREDIT'));
    expect(amountOf()).toMatchObject({
      currency_code: currency,
      value,
      breakdown: { item_total: { value: items }, discount: { value: discount } },
    });
  });

  it('refuses a three-decimal currency before anything is sent', async () => {
    const input = discounted(FIFTEEN_PERCENT, 'KWD', 19990, 'CREDIT');
    await expect(provider().createOneTimeCheckout(input)).rejects.toMatchObject({ code: 'BILLING_AMOUNT_NOT_CHARGEABLE', statusCode: 400 });
    expect(orders).toEqual([]);
  });
});

describe('Razorpay is sent the price less the discount', () => {
  const provider = (): RealRazorpayProvider => new RealRazorpayProvider({ keyId: 'rzp_test_x', keySecret: 's', webhookSecret: 'w' });
  beforeEach(() => {
    razorpayStub.links.length = 0;
  });

  it.each([
    ['a percentage', FIFTEEN_PERCENT, 'INR', 149900, 127415, '22485'],
    ['a percentage', FIFTEEN_PERCENT, 'JPY', 1999, 1699, '300'],
    ['a percentage', FIFTEEN_PERCENT, 'HUF', 499000, 424100, '74900'],
    ['a fixed amount', FIXED, 'INR', 149900, 109900, '40000'],
    ['a fixed amount', FIXED, 'JPY', 1999, 1499, '500'],
    ['a fixed amount', FIXED, 'HUF', 499000, 449000, '50000'],
  ])('%s on a %s price of %i goes out as amount %i', async (_kind, coupon, currency, amount, wire, noted) => {
    await provider().createOneTimeCheckout(discounted(coupon, currency, amount, 'CREDIT'));
    expect(razorpayStub.links[0]).toMatchObject({ amount: wire, currency, notes: { rekey_discount_amount: noted } });
  });
});
