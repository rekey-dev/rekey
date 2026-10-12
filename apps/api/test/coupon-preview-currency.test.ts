/**
 * `POST /billing/coupons/validate` quotes against the price the caller's
 * checkout would select, and refuses exactly what that checkout refuses.
 *
 * Every case here asks the preview and then opens the checkout with the same
 * arguments: the two must agree on the currency, the discount and the error.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

describe('coupon preview in the currency checkout selects', () => {
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
    // A one-time pack: both providers honour a coupon on a one-off charge.
    await w.createPlan({ slug: 'pack', name: '100 credits', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 100 });
    await w.putPrice('pack', 'INR', 79900);
    for (const coupon of [
      { code: 'HALF', discountType: 'PERCENT', basisPoints: 5000 },
      { code: 'FIVEUSD', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 500 }] },
    ]) {
      const res = await w.operator('POST', '/coupons', coupon);
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  function preview(body: Record<string, unknown>, opts: { key?: string; buyer?: Buyer } = {}) {
    return w.asBuyer('POST', '/coupons/validate', { planSlug: 'pack', ...body }, opts);
  }
  function buy(body: Record<string, unknown>, opts: { key?: string; buyer?: Buyer } = {}) {
    return w.checkout({ planSlug: 'pack', ...body }, opts);
  }

  it('quotes a percent coupon against the INR price a buyer in India is charged', async () => {
    const res = await preview({ code: 'HALF', country: 'IN' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      currency: 'INR',
      amount: 79900,
      discountAmount: 39950,
      amountAfterDiscount: 39950,
      plan: { slug: 'pack', name: '100 credits' },
      price: { currency: 'INR', amount: 79900, formatted: '₹799.00', isDefault: false, reason: 'country' },
      priceFallback: null,
      formatted: { discount: '₹399.50', total: '₹399.50' },
    });
    // The plan's default price is not in the quote: the price charged is.
    expect(res.json().data.plan).toEqual({ slug: 'pack', name: '100 credits' });

    const bought = await buy({ couponCode: 'HALF', country: 'IN' });
    expect(bought.json().data).toMatchObject({ currency: 'INR', unitAmount: 79900, discountAmount: 39950 });
  });

  it('quotes the default price when no country is given', async () => {
    const res = await preview({ code: 'HALF' });
    expect(res.json().data).toMatchObject({ currency: 'USD', amount: 1000, discountAmount: 500, amountAfterDiscount: 500 });
    expect((await buy({ couponCode: 'HALF' })).json().data).toMatchObject({ currency: 'USD', discountAmount: 500 });
  });

  it('answers COUPON_CURRENCY_NOT_COVERED for a USD coupon exactly when the checkout would', async () => {
    const refused = await preview({ code: 'FIVEUSD', country: 'IN' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('COUPON_CURRENCY_NOT_COVERED');
    const checkoutRefused = await buy({ couponCode: 'FIVEUSD', country: 'IN' });
    expect(checkoutRefused.json().error.code).toBe('COUPON_CURRENCY_NOT_COVERED');

    const accepted = await preview({ code: 'FIVEUSD' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().data).toMatchObject({ currency: 'USD', amount: 1000, discountAmount: 500 });
    expect((await buy({ couponCode: 'FIVEUSD' })).statusCode).toBe(200);
  });

  it('takes `currency` from a secret key and refuses it from a publishable key, as checkout does', async () => {
    const named = await preview({ code: 'HALF', currency: 'INR' });
    expect(named.json().data).toMatchObject({ currency: 'INR', amount: 79900, discountAmount: 39950 });
    // The currency named decides, so the USD coupon no longer fits.
    expect((await preview({ code: 'FIVEUSD', currency: 'INR' })).json().error.code).toBe('COUPON_CURRENCY_NOT_COVERED');

    const browser = await preview({ code: 'HALF', currency: 'INR' }, { key: w.publishableKey });
    expect(browser.statusCode).toBe(400);
    expect(browser.json().error.code).toBe('BILLING_CURRENCY_NOT_ALLOWED');
    const browserCheckout = await buy({ couponCode: 'HALF', currency: 'INR' }, { key: w.publishableKey });
    expect(browserCheckout.json().error.code).toBe('BILLING_CURRENCY_NOT_ALLOWED');

    const unsold = await preview({ code: 'HALF', currency: 'EUR' });
    expect(unsold.json().error.code).toBe('BILLING_PLAN_CURRENCY_UNAVAILABLE');
  });

  it('does not let a country a browser merely states select the local price', async () => {
    const res = await preview({ code: 'FIVEUSD', country: 'IN' }, { key: w.publishableKey });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ currency: 'USD', amount: 1000, discountAmount: 500 });
    const bought = await buy({ couponCode: 'FIVEUSD', country: 'IN' }, { key: w.publishableKey });
    expect(bought.json().data).toMatchObject({ currency: 'USD', discountAmount: 500 });

    // Once the operator opts in, the stated country selects, here and at checkout.
    const app0 = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
    await prisma.application.update({
      where: { id: w.applicationId },
      data: { billingConfig: { ...(app0.billingConfig as object), localPrices: 'any' } },
    });
    const other = await w.newBuyer();
    const local = await preview({ code: 'FIVEUSD', country: 'IN', planSlug: 'pro' }, { key: w.publishableKey, buyer: other });
    expect(local.json().error.code).toBe('COUPON_CURRENCY_NOT_COVERED');
  });

  it('keeps a credit pack on the default price for a country a browser states, even when the Application says any', async () => {
    const app0 = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
    await prisma.application.update({
      where: { id: w.applicationId },
      data: { billingConfig: { ...(app0.billingConfig as object), localPrices: 'any' } },
    });
    expect(await prisma.plan.findFirstOrThrow({ where: { slug: 'pack' } })).toMatchObject({ kind: 'CREDIT', localPrices: 'TRUSTED' });

    // The same credits at a purchasing-power price are cheap credits, so a
    // credit pack needs more than a browser's word. The plan narrows the rule.
    const hinted = await preview({ code: 'FIVEUSD', country: 'IN' }, { key: w.publishableKey });
    expect(hinted.statusCode, hinted.body).toBe(200);
    expect(hinted.json().data).toMatchObject({ currency: 'USD', amount: 1000, discountAmount: 500 });
    const bought = await buy({ country: 'IN' }, { key: w.publishableKey });
    expect(bought.json().data).toMatchObject({ currency: 'USD', unitAmount: 1000, price: { reason: 'default' } });

    // A country a server declares is still believed.
    const declared = await buy({ country: 'IN' }, { buyer: await w.newBuyer() });
    expect(declared.json().data).toMatchObject({ currency: 'INR', unitAmount: 79900, price: { reason: 'country' } });

    // Local prices switched off for the plan: nobody's country selects one.
    await prisma.plan.updateMany({ where: { slug: 'pack' }, data: { localPrices: 'OFF' } });
    const off = await buy({ country: 'IN' }, { buyer: await w.newBuyer() });
    expect(off.json().data).toMatchObject({ currency: 'USD', unitAmount: 1000, price: { reason: 'default' } });
  });

  it('quotes a subscriber in the currency they already pay in, with no country given', async () => {
    const first = await w.sessionOf(await w.checkout({ country: 'IN' }));
    await w.razorpayWebhook({
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: first.row.providerSessionId, status: 'active' } } },
    });
    await w.createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
    await w.putPrice('team', 'INR', 399900);

    // Bound to Razorpay in INR, which cannot discount one period of a
    // subscription: the quote refuses as the checkout does, naming it.
    const res = await preview({ code: 'HALF', planSlug: 'team' });
    const bought = await buy({ couponCode: 'HALF', planSlug: 'team' });
    expect(bought.statusCode).toBe(400);
    expect(res.statusCode).toBe(bought.statusCode);
    expect(res.json().error).toMatchObject({ code: 'BILLING_DISCOUNT_UNSUPPORTED', details: expect.objectContaining({ provider: 'razorpay' }) });
    expect(res.json().error.code).toBe(bought.json().error.code);
    // A buyer bound to INR cannot be quoted in a named USD either.
    const conflict = await preview({ code: 'HALF', planSlug: 'team', currency: 'USD' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('BILLING_CURRENCY_CONFLICT');
  });
});
