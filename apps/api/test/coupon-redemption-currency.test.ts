/**
 * A coupon redemption records the currency its discount is in, and the
 * operator's coupon totals never add two currencies together.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface CouponStats {
  code: string;
  redemptionCount: number;
  discountIssuedByCurrency: Array<{ currency: string; amount: number; redemptions: number }>;
}

describe('coupon redemption currency', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;
  let halfId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
    await w.createPlan({ slug: 'pack', name: '100 credits', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 100 });
    await w.putPrice('pack', 'INR', 79900);
    const res = await w.operator('POST', '/coupons', { code: 'HALF', discountType: 'PERCENT', basisPoints: 5000 });
    expect(res.statusCode, res.body).toBe(201);
    halfId = (res.json().data as { id: string }).id;
  });

  /** Buy the pack in India through Razorpay; returns the provider session id. */
  async function openInr(buyer?: Buyer): Promise<string> {
    const { row } = await w.sessionOf(
      await w.checkout({ planSlug: 'pack', country: 'IN', couponCode: 'HALF' }, buyer ? { buyer } : {}),
    );
    expect(row.currency).toBe('INR');
    return row.providerSessionId;
  }
  async function payInr(sessionId: string, paymentId: string): Promise<void> {
    const hook = await w.razorpayWebhook({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: sessionId } },
        payment: { entity: { id: paymentId, amount: 39950, currency: 'INR' } },
      },
    });
    expect(hook.statusCode, hook.body).toBe(200);
  }
  /** Buy the pack at the default USD price through Stripe, and settle it. */
  async function buyUsd(buyer: Buyer, paymentId: string): Promise<void> {
    const { row, provider } = await w.sessionOf(await w.checkout({ planSlug: 'pack', couponCode: 'HALF' }, { buyer }));
    expect(provider).toBe('stripe');
    await applyBillingEvent(
      {
        type: 'checkout.completed',
        providerEventId: `evt_${paymentId}`,
        applicationId: w.applicationId,
        checkoutSessionId: row.providerSessionId,
        providerSubscriptionId: null,
        payment: { providerPaymentId: paymentId, amount: 500, currency: 'usd', description: null },
        raw: {},
      },
      { log: app.log, provider: 'stripe' },
    );
  }
  async function stats(): Promise<CouponStats> {
    const res = await w.operator('GET', '/coupons');
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { items: CouponStats[] }).items.find((c) => c.code === 'half')!;
  }
  async function setAppCurrency(currency: string): Promise<void> {
    const row = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
    await prisma.application.update({
      where: { id: w.applicationId },
      data: { billingConfig: { ...(row.billingConfig as object), reportingCurrency: currency } },
    });
  }

  it('stamps the checkout currency on the reservation and keeps it when the payment settles', async () => {
    const sessionId = await openInr();
    expect(await prisma.couponRedemption.findFirstOrThrow({ where: { couponId: halfId } })).toMatchObject({
      status: 'RESERVED',
      discountAmount: 39950,
      currency: 'INR',
    });
    await payInr(sessionId, 'pay_inr_1');
    expect(await prisma.couponRedemption.findMany({ where: { couponId: halfId } })).toMatchObject([
      { status: 'CONFIRMED', discountAmount: 39950, currency: 'INR', checkoutSessionId: sessionId },
    ]);
  });

  it('records the currency on a redemption that settles with no reservation left', async () => {
    const sessionId = await openInr();
    // The reservation was swept before the payment arrived.
    await prisma.couponRedemption.deleteMany({ where: { couponId: halfId } });
    await payInr(sessionId, 'pay_inr_2');
    expect(await prisma.couponRedemption.findMany({ where: { couponId: halfId } })).toMatchObject([
      { status: 'CONFIRMED', discountAmount: 39950, currency: 'INR' },
    ]);
  });

  it('reports one row per currency, the reporting currency first, and no sum', async () => {
    await payInr(await openInr(), 'pay_inr_3');
    await buyUsd(await w.newBuyer(), 'pi_usd_1');
    await buyUsd(await w.newBuyer(), 'pi_usd_2');

    // The Application's reporting currency leads when the coupon was redeemed in it.
    await setAppCurrency('INR');
    const reported = await stats();
    expect(reported).toMatchObject({
      redemptionCount: 3,
      discountIssuedByCurrency: [
        { currency: 'INR', amount: 39950, redemptions: 1 },
        { currency: 'USD', amount: 1000, redemptions: 2 },
      ],
    });
    expect(reported).not.toHaveProperty('totalDiscountIssued');
    expect(reported).not.toHaveProperty('discountCurrency');

    // Otherwise the currency with the most redemptions, not the largest number.
    await setAppCurrency('EUR');
    expect((await stats()).discountIssuedByCurrency).toEqual([
      { currency: 'USD', amount: 1000, redemptions: 2 },
      { currency: 'INR', amount: 39950, redemptions: 1 },
    ]);
  });

});
