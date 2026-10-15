/**
 * The operator's routing preview with a coupon: each item carries what the
 * coupon takes off the price charged, or the refusal a checkout carrying it
 * would answer with, decided by the functions the buyer's own coupon preview
 * and the checkout use.
 *
 * The world: Stripe charges USD only, Razorpay INR only. `pack` is a one-time
 * credit pack at USD 10.00 and INR 799.00.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RoutingPreviewDto } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('routing preview with a coupon', () => {
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
    await w.createPlan({ slug: 'pack', name: '100 credits', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 100 });
    await w.putPrice('pack', 'INR', 79900);
    for (const coupon of [
      { code: 'BOTH', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 300 }, { currency: 'INR', amountOff: 20000 }] },
      { code: 'DOLLARS', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 300 }] },
      { code: 'BIG', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 5000 }] },
      { code: 'ONCE', discountType: 'PERCENT', basisPoints: 2500, maxRedemptionsPerUser: 1 },
    ]) {
      const res = await w.operator('POST', '/coupons', coupon);
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  async function item(body: Record<string, unknown>) {
    const res = await w.operator('POST', '/billing/checkout/preview', { plan: 'pack', ...body });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as RoutingPreviewDto).items[0]!;
  }

  it('carries the discount and the total in the currency charged, the figures the buyer is quoted', async () => {
    const previewed = await item({ country: 'IN', couponCode: 'BOTH' });
    expect(previewed.price).toMatchObject({ currency: 'INR', amount: 79900 });
    expect(previewed.coupon).toEqual({
      code: 'both',
      discount: {
        currency: 'INR',
        discountAmount: 20000,
        amountAfterDiscount: 59900,
        formatted: { discount: '₹200.00', total: '₹599.00' },
      },
      refusal: null,
    });
    expect(previewed.summary).toContain('With coupon both, ₹200.00 comes off and they pay ₹599.00.');

    const quoted = await w.asBuyer('POST', '/coupons/validate', { planSlug: 'pack', code: 'BOTH', country: 'IN' });
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect(quoted.json().data).toMatchObject({ currency: 'INR', discountAmount: 20000, amountAfterDiscount: 59900 });
  });

  it('carries the refusal for a coupon that does not cover the currency charged, beside the price and provider', async () => {
    const eventsBefore = await prisma.billingEvent.count();
    const outboxBefore = await prisma.billingEventOutbox.count();
    const previewed = await item({ country: 'IN', couponCode: 'DOLLARS' });
    expect(previewed.refusal).toBeNull();
    expect(previewed.price).toMatchObject({ currency: 'INR', amount: 79900 });
    expect(previewed.provider).toBe('razorpay');
    expect(previewed.coupon).toMatchObject({ code: 'DOLLARS', discount: null, refusal: { code: 'COUPON_CURRENCY_NOT_COVERED' } });
    expect(previewed.coupon!.refusal!.message).toContain('INR');
    expect(previewed.summary).toContain('With coupon DOLLARS the checkout is refused');
    // An operator asking is not a buyer being refused.
    expect(await prisma.billingEvent.count()).toBe(eventsBefore);
    expect(await prisma.billingEventOutbox.count()).toBe(outboxBefore);

    expect((await item({ country: 'US', couponCode: 'DOLLARS' })).coupon).toMatchObject({
      discount: { currency: 'USD', discountAmount: 300, amountAfterDiscount: 700 },
      refusal: null,
    });
  });

  it('carries the refusals checkout makes after the provider is picked, and an unknown code', async () => {
    expect((await item({ country: 'US', couponCode: 'BIG' })).coupon).toMatchObject({
      discount: null,
      refusal: { code: 'COUPON_FULL_DISCOUNT_UNSUPPORTED' },
    });
    expect((await item({ country: 'US', couponCode: 'NOPE' })).coupon).toMatchObject({
      code: 'NOPE',
      discount: null,
      refusal: { code: 'COUPON_NOT_FOUND' },
    });
  });

  it('judges the per-buyer limit for a named end user, and only the overall limit without one', async () => {
    const coupon = await prisma.coupon.findFirstOrThrow({ where: { applicationId: w.applicationId, code: 'once' } });
    await prisma.couponRedemption.create({
      data: { couponId: coupon.id, applicationId: w.applicationId, endUserId: w.buyer.id, status: 'CONFIRMED', currency: 'USD', discountAmount: 250 },
    });
    expect((await item({ country: 'US', couponCode: 'ONCE', endUserId: w.buyer.id })).coupon).toMatchObject({
      discount: null,
      refusal: { code: 'COUPON_USER_LIMIT_REACHED' },
    });
    expect((await item({ country: 'US', couponCode: 'ONCE' })).coupon).toMatchObject({
      discount: { currency: 'USD', discountAmount: 250, amountAfterDiscount: 750 },
    });
  });
});
