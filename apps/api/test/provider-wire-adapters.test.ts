/**
 * What the real adapters put on the wire for money that is not two-decimal,
 * and what they read back. The conversion functions are covered by
 * `provider-amount-scale.test.ts`; this holds each CALL SITE to using them,
 * with literal expected values. A US dollar amount is the same integer
 * before and after, so every case here uses a currency where it is not:
 * ISK and MGA at Stripe, HUF and JPY at PayPal.
 *
 * The SDKs and `fetch` are stubbed. Nothing dials a processor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndUser } from '@prisma/client';
import { RealPaypalProvider } from '../src/modules/billing/providers/paypal.js';
import { RealRazorpayProvider } from '../src/modules/billing/providers/razorpay.js';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import type { CheckoutSessionInput, HostedFallbackInput, PricedPlan } from '../src/modules/billing/providers/types.js';
import { pricedPlanFixture, type FixturePlan } from './priced-plan-fixture.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

type Recorded = { op: string; params: Record<string, unknown> };

const stripeStub = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; params: Record<string, unknown> }>,
  sessions: new Map<string, Record<string, unknown>>(),
  refund: { id: 're_1', amount: 0, currency: 'usd', status: 'succeeded' } as Record<string, unknown>,
}));

vi.mock('stripe', () => {
  const record = (op: string, result: (params: Record<string, unknown>) => unknown) => async (params: Record<string, unknown>) => {
    stripeStub.calls.push({ op, params });
    return result(params);
  };
  class FakeStripe {
    products = { create: record('products.create', () => ({ id: 'prod_1' })) };
    prices = { create: record('prices.create', () => ({ id: 'price_new' })) };
    coupons = { create: record('coupons.create', () => ({ id: 'co_1' })), del: async () => ({}) };
    refunds = { create: record('refunds.create', () => stripeStub.refund) };
    checkout = {
      sessions: {
        create: record('sessions.create', () => ({ id: 'cs_new', url: 'https://checkout.stripe.test/cs_new' })),
        retrieve: async (id: string) => {
          const session = stripeStub.sessions.get(id);
          if (!session) throw Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' });
          return session;
        },
        expire: async (id: string) => {
          stripeStub.sessions.set(id, { ...stripeStub.sessions.get(id), status: 'expired' });
          return stripeStub.sessions.get(id);
        },
      },
    };
  }
  return { default: FakeStripe };
});

const razorpayStub = vi.hoisted(() => ({ calls: [] as Array<{ op: string; params: Record<string, unknown> }> }));

vi.mock('razorpay', () => {
  class FakeRazorpay {
    plans = {
      create: async (params: Record<string, unknown>) => {
        razorpayStub.calls.push({ op: 'plans.create', params });
        return { id: 'plan_new' };
      },
    };
    paymentLink = {
      create: async (params: Record<string, unknown>) => {
        razorpayStub.calls.push({ op: 'paymentLink.create', params });
        return { id: 'plink_1', short_url: 'https://rzp.test/i/1' };
      },
    };
  }
  return { default: FakeRazorpay };
});

const endUser = { id: 'eu_1', email: 'buyer@example.com' } as unknown as EndUser;

function plan(currency: string, amount: number, over: Partial<FixturePlan> = {}): PricedPlan {
  return pricedPlanFixture({
    id: 'pl_1',
    applicationId: 'app_1',
    slug: 'pro',
    name: 'Pro',
    amount,
    currency,
    interval: 'MONTH',
    kind: 'SUBSCRIPTION',
    metadata: {},
    ...over,
  } as unknown as FixturePlan);
}

function checkout(priced: PricedPlan, over: Partial<CheckoutSessionInput> = {}): CheckoutSessionInput {
  return {
    application: { id: 'app_1', slug: 'app' },
    endUser,
    plan: priced,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
    ...over,
  };
}

const stripeCalls = (op: string): Recorded[] => stripeStub.calls.filter((call) => call.op === op);

describe('Stripe adapter', () => {
  const provider = (): RealStripeProvider =>
    new RealStripeProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x', publishableKey: 'pk_test_x' });

  beforeEach(() => {
    stripeStub.calls.length = 0;
    stripeStub.sessions.clear();
  });

  it.each([
    // ISK 5,000: Stripe wants two decimals that are always 00.
    ['ISK', 5000, 500000],
    // MGA 1,500: stored with two decimals, Stripe takes none.
    ['MGA', 150000, 1500],
    // VND 50,000 and KRW 5,000: no decimals either side.
    ['VND', 50000, 50000],
    ['KRW', 5000, 5000],
    ['USD', 1999, 1999],
  ])('registers a recurring %s price of %i as unit_amount %i', async (currency, stored, wire) => {
    await provider().ensurePlanRegistered(plan(currency, stored));
    expect(stripeCalls('prices.create')[0]!.params).toMatchObject({ unit_amount: wire, currency: currency.toLowerCase() });
  });

  it('mints a coupon for an ISK discount in the scale Stripe reads it at', async () => {
    const priced = plan('ISK', 5000, { metadata: { stripe: { priceId: 'price_isk' } } });
    await provider().createCheckoutSession(
      checkout(priced, { discount: { amount: 1000, currency: 'ISK', couponId: 'c_1', code: 'tenth' } }),
    );
    expect(stripeCalls('coupons.create')[0]!.params).toMatchObject({ amount_off: 100000, currency: 'isk' });
  });

  it('asks for a partial ISK refund in Stripe scale, and reports what was refunded in stored units', async () => {
    stripeStub.refund = { id: 're_isk', amount: 250000, currency: 'isk', status: 'succeeded' };
    const result = await provider().refundPayment({
      providerPaymentId: 'pi_isk',
      idempotencyKey: 'rekey-refund-isk-0001',
      amount: 2500,
      currency: 'ISK',
    });
    expect(stripeCalls('refunds.create')[0]!.params).toMatchObject({ payment_intent: 'pi_isk', amount: 250000 });
    expect(result).toMatchObject({ refundId: 're_isk', amount: 2500, currency: 'ISK', status: 'succeeded' });
  });

  it('reports an MGA refund Stripe made in whole ariary as stored hundredths', async () => {
    stripeStub.refund = { id: 're_mga', amount: 1500, currency: 'mga', status: 'succeeded' };
    const result = await provider().refundPayment({
      providerPaymentId: 'pi_mga',
      idempotencyKey: 'rekey-refund-mga-0001',
      amount: 150000,
      currency: 'MGA',
    });
    expect(stripeCalls('refunds.create')[0]!.params).toMatchObject({ amount: 1500 });
    expect(result).toMatchObject({ amount: 150000, currency: 'MGA' });
  });

  it('carries a one-time ISK purchase to the hosted page at the amount the elements session charged', async () => {
    stripeStub.sessions.set('cs_elements', {
      id: 'cs_elements',
      status: 'open',
      metadata: { applicationId: 'app_1' },
      discounts: [],
      // ISK 5,000 as Stripe holds it.
      amount_subtotal: 500000,
      currency: 'isk',
    });
    const fallback: HostedFallbackInput = {
      ...checkout(plan('ISK', 9999, { kind: 'CREDIT' })),
      kind: 'one_time',
      embeddedSessionId: 'cs_elements',
      idempotencyKey: 'rekey-checkout-fallback-row-cs_elements',
      priceId: null,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    };
    await provider().createHostedFallback(fallback);
    expect(stripeCalls('sessions.create')[0]!.params).toMatchObject({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'isk', unit_amount: 500000 } }],
    });
  });
});

describe('PayPal adapter', () => {
  let requests: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
        requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        if (url.includes('/v2/checkout/orders')) {
          return Response.json({ id: 'ORDER-1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' }, { rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] }, { status: 201 });
        }
        if (url.includes('/refund')) {
          return Response.json({ id: 'REF-1', status: 'COMPLETED', amount: { value: '2500', currency_code: 'HUF' } }, { status: 201 });
        }
        return Response.json({});
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const provider = (): RealPaypalProvider => new RealPaypalProvider({ clientId: 'c', clientSecret: 's', webhookId: 'wh' }, 'test');
  const order = () => requests.find((request) => request.url.includes('/v2/checkout/orders'))!.body as {
    purchase_units: Array<{ amount: { value: string; currency_code: string; breakdown?: { item_total: { value: string }; discount: { value: string } } } }>;
  };

  it.each([
    // The forint and the yen take no decimals at PayPal; the koruna takes two.
    ['HUF', 500000, '5000'],
    ['JPY', 5000, '5000'],
    ['CZK', 15000, '150.00'],
    ['USD', 1999, '19.99'],
  ])('opens a one-time %s order for stored %i as value "%s"', async (currency, stored, value) => {
    await provider().createOneTimeCheckout(checkout(plan(currency, stored, { kind: 'CREDIT' })));
    expect(order().purchase_units[0]!.amount).toMatchObject({ value, currency_code: currency });
  });

  it('itemises a HUF discount with no decimals, and the breakdown adds up', async () => {
    await provider().createOneTimeCheckout(
      checkout(plan('HUF', 500000, { kind: 'CREDIT' }), { discount: { amount: 75000, currency: 'HUF', couponId: 'c_1', code: 'pct15' } }),
    );
    const { amount } = order().purchase_units[0]!;
    expect(amount.value).toBe('4250');
    expect(amount.breakdown).toMatchObject({ item_total: { value: '5000' }, discount: { value: '750' } });
  });

});

describe('Razorpay adapter', () => {
  beforeEach(() => {
    razorpayStub.calls.length = 0;
  });

  const provider = (): RealRazorpayProvider =>
    new RealRazorpayProvider({ keyId: 'rzp_test_x', keySecret: 's', webhookSecret: 'w' });

  it.each([
    ['INR', 149900, 149900],
    // The won has no subunit: KRW 5,000 is 5000, not 500000.
    ['KRW', 5000, 5000],
    ['JPY', 5000, 5000],
  ])('opens a %s payment link for stored %i as amount %i', async (currency, stored, wire) => {
    await provider().createOneTimeCheckout(checkout(plan(currency, stored, { kind: 'CREDIT' })));
    const link = razorpayStub.calls.find((call) => call.op === 'paymentLink.create')!;
    expect(link.params).toMatchObject({ amount: wire, currency });
  });
});
