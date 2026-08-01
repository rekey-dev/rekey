/**
 * Coupon discounts have to reach the payment provider.
 *
 * The regression these pin: checkout validated the coupon, stamped
 * `discountAmount` on the Subscription, returned it in the response, and
 * redeemed the code when the payment landed — while handing the provider a
 * checkout input with no discount in it at all. Every coupon ever applied
 * charged the buyer full price. Asserting on the response DTO could never
 * have caught it, because the DTO was right; only what the PROVIDER received
 * tells the truth, so that is what these look at.
 *
 * The other half is the refusals. Providers differ on what they can discount,
 * and the wrong answer to "PayPal cannot take this" is to charge full price
 * and record a discount anyway.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { configureSandboxPaypal, configureSandboxStripe } from './fakes/billing-credentials.js';
import { fakePaypal, fakeStripe } from './fakes/billing-providers.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

/** Recurring plan price, in cents. Round numbers keep the arithmetic obvious. */
const SUB_AMOUNT = 1000;
/** One-off (CREDIT pack) price, in cents. */
const PACK_AMOUNT = 5000;

const PASSWORD = 'pw-one-two-three';

describe('coupon discounts reach the provider', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let userAccess: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    fakeStripe.lastCheckout = null;
    fakePaypal.lastCheckout = null;

    // Operator flow rather than the super-admin one: only the tenant plans
    // route takes `kind`, and half of these cases need a CREDIT pack (the
    // one-time path).
    const slug = `disc-${Math.random().toString(36).slice(2, 8)}`;
    const operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: 'k' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    // Both providers configured: the discount rules differ between them, and
    // an explicit `provider` on checkout is what lets one test pick each.
    await configureSandboxStripe(applicationId);
    await configureSandboxPaypal(applicationId);

    await createPlan(operatorAccess, { slug: 'pro', name: 'Pro', amount: SUB_AMOUNT });
    await createPlan(operatorAccess, {
      slug: 'pack',
      name: 'Credit pack',
      amount: PACK_AMOUNT,
      kind: 'CREDIT',
      creditsAmount: 100,
    });

    userAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  async function createPlan(
    operatorAccess: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
  }

  async function createCoupon(payload: Record<string, unknown>): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
  }

  function checkout(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: {
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        ...payload,
      },
    });
  }

  it('hands a recurring checkout the discount, not just the local row', async () => {
    await createCoupon({ code: 'half', discountType: 'PERCENT', amountOff: 5000 });

    const res = await checkout({ planSlug: 'pro', couponCode: 'half', provider: 'stripe' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.discountAmount).toBe(SUB_AMOUNT / 2);
    // The assertion that would have failed before this fix.
    expect(fakeStripe.lastCheckout?.discount).toEqual({
      amount: SUB_AMOUNT / 2,
      currency: 'USD',
      couponId: expect.any(String),
      code: 'half',
    });
  });

  it('hands a one-time checkout the discount too', async () => {
    await createCoupon({ code: 'tenoff', discountType: 'AMOUNT', amountOff: 1000 });

    const res = await checkout({ planSlug: 'pack', couponCode: 'tenoff', provider: 'stripe' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.subscription.metadata.oneTime).toBe(true);
    expect(fakeStripe.lastCheckout?.discount?.amount).toBe(1000);
  });

  it('sends no discount at all when no coupon was given', async () => {
    const res = await checkout({ planSlug: 'pro', provider: 'stripe' });

    expect(res.statusCode).toBe(200);
    expect(fakeStripe.lastCheckout?.discount).toBeUndefined();
  });

  it('carries the coupon id so the provider-side record points back at ours', async () => {
    await createCoupon({ code: 'traceable', discountType: 'AMOUNT', amountOff: 250 });

    await checkout({ planSlug: 'pro', couponCode: 'traceable', provider: 'stripe' });

    const coupon = await prisma.coupon.findFirstOrThrow({ where: { code: 'traceable' } });
    expect(fakeStripe.lastCheckout?.discount?.couponId).toBe(coupon.id);
  });

  describe('providers that cannot apply the discount refuse the sale', () => {
    it('PayPal rejects a coupon on a recurring subscription', async () => {
      await createCoupon({ code: 'nope', discountType: 'PERCENT', amountOff: 2000 });

      const res = await checkout({ planSlug: 'pro', couponCode: 'nope', provider: 'paypal' });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BILLING_DISCOUNT_UNSUPPORTED');
      // The refusal has to be cheap: nothing local, nothing at the provider.
      expect(await prisma.subscription.count({ where: { applicationId } })).toBe(0);
      expect(await prisma.couponRedemption.count({ where: { applicationId } })).toBe(0);
      expect(fakePaypal.lastCheckout).toBeNull();
    });

    it('PayPal still sells the same plan at full price without the coupon', async () => {
      // The refusal must be about the discount, not about PayPal.
      const res = await checkout({ planSlug: 'pro', provider: 'paypal' });

      expect(res.statusCode).toBe(200);
      expect(fakePaypal.lastCheckout?.discount).toBeUndefined();
    });

    it('PayPal takes the coupon on a one-time purchase (Orders v2 has a discount line)', async () => {
      await createCoupon({ code: 'packoff', discountType: 'AMOUNT', amountOff: 1500 });

      const res = await checkout({ planSlug: 'pack', couponCode: 'packoff', provider: 'paypal' });

      expect(res.statusCode).toBe(200);
      expect(fakePaypal.lastCheckout?.discount?.amount).toBe(1500);
    });
  });

  describe('guard rails on the resulting charge', () => {
    it('refuses a coupon that rounds down to no discount', async () => {
      // 0.01% of $10.00 floors to zero. Stripe rejects `amount_off: 0`, and
      // accepting it would burn one of the buyer's redemptions on nothing.
      await createCoupon({ code: 'crumbs', discountType: 'PERCENT', amountOff: 1 });

      const res = await checkout({ planSlug: 'pro', couponCode: 'crumbs', provider: 'stripe' });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('COUPON_NO_DISCOUNT');
      expect(fakeStripe.lastCheckout).toBeNull();
    });

    it('refuses a full-price coupon on a one-time purchase', async () => {
      // Nowhere to land: no provider takes a zero-value one-off order, and
      // fulfilment hangs off the payment-succeeded webhook that would never
      // fire — the buyer would pay nothing and receive nothing.
      await createCoupon({ code: 'freepack', discountType: 'PERCENT', amountOff: 10000 });

      const res = await checkout({ planSlug: 'pack', couponCode: 'freepack', provider: 'stripe' });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('COUPON_FULL_DISCOUNT_UNSUPPORTED');
      expect(fakeStripe.lastCheckout).toBeNull();
    });

    it('allows a full-price coupon on a recurring subscription', async () => {
      // Deliberately not symmetrical with the one-time case: a zero first
      // invoice settles as paid and still emits the activation, so a fully
      // comped first period works end to end where the provider supports it.
      await createCoupon({ code: 'firstfree', discountType: 'PERCENT', amountOff: 10000 });

      const res = await checkout({ planSlug: 'pro', couponCode: 'firstfree', provider: 'stripe' });

      expect(res.statusCode).toBe(200);
      expect(fakeStripe.lastCheckout?.discount?.amount).toBe(SUB_AMOUNT);
    });
  });
});
