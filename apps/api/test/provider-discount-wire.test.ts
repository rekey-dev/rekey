/**
 * What each real provider actually puts on the wire for a coupon discount.
 *
 * `coupon-discount-provider.test.ts` proves the discount leaves Rekey; this
 * proves it arrives in the shape the processor expects, which is where the
 * three of them stop resembling each other. The SDKs / `fetch` are stubbed —
 * nothing here dials a payment processor — so what is under test is the
 * request body, and only that.
 *
 * These construct the provider classes directly, so the `getProviderForApplication`
 * mock in test/setup.ts is irrelevant here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndUser, Plan } from '@prisma/client';
import { RealPaypalProvider } from '../src/modules/billing/providers/paypal.js';
import { RealRazorpayProvider } from '../src/modules/billing/providers/razorpay.js';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import type { CheckoutSessionInput } from '../src/modules/billing/providers/types.js';

const stripeSpy = vi.hoisted(() => ({
  coupons: [] as Record<string, unknown>[],
  sessions: [] as Record<string, unknown>[],
}));

vi.mock('stripe', () => {
  class FakeStripe {
    coupons = {
      create: async (params: Record<string, unknown>) => {
        stripeSpy.coupons.push(params);
        return { id: 'co_fake' };
      },
    };
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          stripeSpy.sessions.push(params);
          return { id: 'cs_fake', url: 'https://checkout.stripe.test/cs_fake' };
        },
      },
    };
  }
  return { default: FakeStripe };
});

const razorpaySpy = vi.hoisted(() => ({ links: [] as Record<string, unknown>[] }));

vi.mock('razorpay', () => {
  class FakeRazorpay {
    paymentLink = {
      create: async (body: Record<string, unknown>) => {
        razorpaySpy.links.push(body);
        return { id: 'plink_fake', short_url: 'https://rzp.test/i/fake' };
      },
    };
  }
  return { default: FakeRazorpay };
});

/** $50.00 plan, so a $12.50 discount is unambiguous in either notation. */
const PLAN_AMOUNT = 5000;
const DISCOUNT_AMOUNT = 1250;

function planFixture(over: Partial<Plan> = {}): Plan {
  return {
    id: 'pl_1',
    applicationId: 'app_1',
    slug: 'pro',
    name: 'Pro',
    amount: PLAN_AMOUNT,
    currency: 'USD',
    interval: 'MONTH',
    metadata: { stripe: { priceId: 'price_fake' } },
    ...over,
  } as unknown as Plan;
}

const endUser = { id: 'eu_1', email: 'buyer@example.com' } as unknown as EndUser;

function checkoutInput(over: Partial<CheckoutSessionInput> = {}): CheckoutSessionInput {
  return {
    application: { id: 'app_1', slug: 'app' },
    endUser,
    plan: planFixture(),
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
    ...over,
  };
}

const discount = {
  amount: DISCOUNT_AMOUNT,
  currency: 'USD',
  couponId: 'cpn_1',
  code: 'half-off',
};

describe('Stripe — discounts ride as an ad-hoc Coupon', () => {
  beforeEach(() => {
    stripeSpy.coupons.length = 0;
    stripeSpy.sessions.length = 0;
  });

  const provider = (): RealStripeProvider =>
    new RealStripeProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x' });

  it('mints a once-only, single-redemption coupon in money, not percent', async () => {
    await provider().createCheckoutSession(checkoutInput({ discount }));

    expect(stripeSpy.coupons).toHaveLength(1);
    expect(stripeSpy.coupons[0]).toMatchObject({
      amount_off: DISCOUNT_AMOUNT,
      currency: 'usd',
      // Rekey records ONE redemption, so the discount buys ONE invoice.
      duration: 'once',
      max_redemptions: 1,
      metadata: { rekeyCouponId: 'cpn_1', rekeyCouponCode: 'half-off' },
    });
    // `percent_off` would let Stripe recompute against its own base and
    // diverge from the integer we recorded and redeemed.
    expect(stripeSpy.coupons[0]).not.toHaveProperty('percent_off');
    expect(stripeSpy.sessions[0]).toMatchObject({
      mode: 'subscription',
      discounts: [{ coupon: 'co_fake' }],
    });
  });

  it('leaves the one-time line item at full price and discounts it separately', async () => {
    await provider().createOneTimeCheckout(checkoutInput({ discount }));

    const session = stripeSpy.sessions[0] as {
      mode: string;
      discounts: unknown;
      line_items: Array<{ price_data: { unit_amount: number } }>;
    };
    expect(session.mode).toBe('payment');
    expect(session.discounts).toEqual([{ coupon: 'co_fake' }]);
    // Subtracting from `unit_amount` would charge the same money while telling
    // the buyer the plan simply costs less, and leave no trace of the coupon.
    expect(session.line_items[0]?.price_data.unit_amount).toBe(PLAN_AMOUNT);
  });

  it('creates no coupon and sends no `discounts` key when there is no coupon', async () => {
    await provider().createCheckoutSession(checkoutInput());

    expect(stripeSpy.coupons).toHaveLength(0);
    expect(stripeSpy.sessions[0]).not.toHaveProperty('discounts');
  });
});

describe('PayPal — Orders v2 takes a discount line, Subscriptions v1 takes nothing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://paypal.test/a' }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const provider = (): RealPaypalProvider =>
    new RealPaypalProvider(
      { clientId: 'c', clientSecret: 's', webhookId: 'wh' },
      'test',
    );

  function orderBody(): {
    purchase_units: Array<{
      description: string;
      amount: {
        value: string;
        breakdown?: { item_total: { value: string }; discount: { value: string } };
      };
      items?: Array<{ unit_amount: { value: string } }>;
    }>;
  } {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v2/checkout/orders'));
    return JSON.parse((call![1] as { body: string }).body);
  }

  it('itemises the discount so the breakdown adds up to the charged value', async () => {
    await provider().createOneTimeCheckout(checkoutInput({ discount }));

    const unit = orderBody().purchase_units[0]!;
    // PayPal rejects an order whose breakdown does not reconcile:
    // item_total - discount === amount.value.
    expect(unit.amount.value).toBe('37.50');
    expect(unit.amount.breakdown?.item_total.value).toBe('50.00');
    expect(unit.amount.breakdown?.discount.value).toBe('12.50');
    expect(unit.items?.[0]?.unit_amount.value).toBe('50.00');
    // No free-form metadata on a purchase unit — the code goes where the buyer
    // and the operator will both see it.
    expect(unit.description).toContain('half-off');
  });

  it('leaves an undiscounted order exactly as it was', async () => {
    await provider().createOneTimeCheckout(checkoutInput());

    const unit = orderBody().purchase_units[0]!;
    expect(unit.amount.value).toBe('50.00');
    expect(unit.amount.breakdown).toBeUndefined();
    expect(unit.items).toBeUndefined();
    expect(unit.description).toBe('Pro');
  });

  it('refuses a discounted subscription rather than billing it at full price', async () => {
    await expect(provider().createCheckoutSession(checkoutInput({ discount }))).rejects.toMatchObject(
      { code: 'BILLING_DISCOUNT_UNSUPPORTED', statusCode: 400 },
    );
    // Refused before a token is even minted — nothing exists at PayPal to undo.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Razorpay — a payment link is discounted by naming a smaller amount', () => {
  beforeEach(() => {
    razorpaySpy.links.length = 0;
  });

  const provider = (): RealRazorpayProvider =>
    new RealRazorpayProvider({ keyId: 'rzp_test_x', keySecret: 's', webhookSecret: 'w' });

  it('charges the net amount and records why in the notes', async () => {
    await provider().createOneTimeCheckout(checkoutInput({ discount }));

    expect(razorpaySpy.links[0]).toMatchObject({
      amount: PLAN_AMOUNT - DISCOUNT_AMOUNT,
      currency: 'USD',
      // The link's own amount is the only discount surface it has, so the
      // reason has to live somewhere the operator can find it.
      notes: { rekey_coupon_code: 'half-off', rekey_discount_amount: String(DISCOUNT_AMOUNT) },
    });
  });

  it('charges the full amount and adds no coupon notes without a coupon', async () => {
    await provider().createOneTimeCheckout(checkoutInput());

    expect(razorpaySpy.links[0]).toMatchObject({ amount: PLAN_AMOUNT });
    expect(razorpaySpy.links[0]?.notes).not.toHaveProperty('rekey_coupon_code');
  });

  it('refuses a discounted subscription (no ad-hoc discount surface exists)', async () => {
    await expect(provider().createCheckoutSession(checkoutInput({ discount }))).rejects.toMatchObject(
      { code: 'BILLING_DISCOUNT_UNSUPPORTED', statusCode: 400 },
    );
    expect(razorpaySpy.links).toHaveLength(0);
  });
});
