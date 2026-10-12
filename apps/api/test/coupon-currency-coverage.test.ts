/**
 * A coupon is judged in the currency the checkout charges. A fixed coupon
 * with no amount in that currency, and a percentage limited to others, is
 * refused where the code is entered and again at checkout, with one code.
 * Nothing is converted, and an amount is never reused in another currency.
 *
 * The world: Stripe charges USD only, Razorpay INR only. `pack` is a one-time
 * credit pack at USD 10.00, INR 799.00, and EUR 9.00 which no provider can
 * charge, so a buyer in Germany falls back to the USD default price.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

interface Quote {
  currency: string;
  amount: number;
  discountAmount: number;
  amountAfterDiscount: number;
}

describe('coupon coverage of the currency charged', () => {
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
    await w.putPrice('pack', 'EUR', 900);
    for (const coupon of [
      { code: 'BOTH', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 300 }, { currency: 'INR', amountOff: 20000 }] },
      { code: 'DOLLARS', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 300 }] },
      { code: 'INRONLY', discountType: 'AMOUNT', amounts: [{ currency: 'INR', amountOff: 20000 }] },
      { code: 'EURONLY', discountType: 'AMOUNT', amounts: [{ currency: 'EUR', amountOff: 200 }] },
      { code: 'EURUSD', discountType: 'AMOUNT', amounts: [{ currency: 'EUR', amountOff: 200 }, { currency: 'USD', amountOff: 300 }] },
      { code: 'PCT', discountType: 'PERCENT', basisPoints: 2500 },
      { code: 'PCTUSD', discountType: 'PERCENT', basisPoints: 2500, currencies: ['USD'] },
      { code: 'BIG', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 5000 }] },
    ]) {
      const res = await w.operator('POST', '/coupons', coupon);
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  const preview = (body: Record<string, unknown>, buyer?: Buyer) =>
    w.asBuyer('POST', '/coupons/validate', { planSlug: 'pack', ...body }, buyer ? { buyer } : {});
  const buy = (body: Record<string, unknown>, buyer?: Buyer) =>
    w.checkout({ planSlug: 'pack', ...body }, buyer ? { buyer } : {});
  const quoteOf = (res: LightMyRequestResponse): Quote => {
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Quote;
  };
  const errorOf = (res: LightMyRequestResponse) => {
    const { code, message, fix, details } = res.json().error as {
      code: string;
      message: string;
      fix: string;
      details?: Record<string, unknown>;
    };
    return { code, message, fix, details };
  };
  const redemptions = async (code: string): Promise<number> => {
    const items = ((await w.operator('GET', '/coupons')).json().data as { items: Array<{ code: string; redemptionCount: number }> }).items;
    return items.find((c) => c.code === code.toLowerCase())!.redemptionCount;
  };
  const refusedEvents = (reasonCode: string) =>
    prisma.billingEvent.findMany({
      where: { applicationId: w.applicationId, type: 'coupon.refused', data: { path: ['reasonCode'], equals: reasonCode } },
      orderBy: { seq: 'asc' },
    });

  it('takes the amount stated for the currency charged, in each currency, and converts nothing', async () => {
    expect(quoteOf(await preview({ code: 'BOTH' }))).toMatchObject({ currency: 'USD', amount: 1000, discountAmount: 300, amountAfterDiscount: 700 });
    expect(quoteOf(await preview({ code: 'BOTH', country: 'IN' }))).toMatchObject({ currency: 'INR', amount: 79900, discountAmount: 20000, amountAfterDiscount: 59900 });

    expect((await buy({ couponCode: 'BOTH' }, await w.newBuyer())).json().data).toMatchObject({ provider: 'stripe', currency: 'USD', unitAmount: 1000, discountAmount: 300 });
    const inr = await w.sessionOf(await buy({ couponCode: 'BOTH', country: 'IN' }, await w.newBuyer()));
    expect(inr).toMatchObject({ provider: 'razorpay', row: { currency: 'INR', unitAmount: 79900, discountAmount: 20000, chargeAmount: 59900 } });
  });

  it('tells a buyer the code, the kind and the rate, and nothing else about the coupon', async () => {
    await w.operator('POST', '/coupons', {
      code: 'SECRETS',
      discountType: 'AMOUNT',
      amounts: [{ currency: 'USD', amountOff: 300 }, { currency: 'INR', amountOff: 20000 }],
      maxRedemptions: 7,
      maxRedemptionsPerUser: 2,
      planSlugs: ['pack'],
      metadata: { campaign: 'private-note' },
    });
    const fixed = await preview({ code: 'SECRETS' }, undefined);
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json().data.coupon).toEqual({ code: 'secrets', discountType: 'AMOUNT', basisPoints: null });
    expect(Object.keys(fixed.json().data as object).sort()).toEqual(
      ['amount', 'amountAfterDiscount', 'coupon', 'currency', 'discountAmount', 'formatted', 'plan', 'price', 'priceFallback'],
    );
    // Not the rupee amount, the limits or the operator's note.
    for (const hidden of ['20000', 'INR', 'maxRedemptions', 'private-note', 'planSlugs']) {
      expect(fixed.body).not.toContain(hidden);
    }
    expect((await preview({ code: 'PCT' })).json().data.coupon).toEqual({ code: 'pct', discountType: 'PERCENT', basisPoints: 2500 });
  });

  it('refuses a fixed coupon with no amount in the currency charged, where the code is entered and at checkout', async () => {
    const quoted = await preview({ code: 'DOLLARS', country: 'IN' });
    expect(quoted.statusCode, quoted.body).toBe(400);
    const error = errorOf(quoted);
    expect(error.code).toBe('COUPON_CURRENCY_NOT_COVERED');
    expect(error.message).toBe('Coupon "DOLLARS" does not work for prices in INR.');
    expect(error.details).toEqual({ chargedCurrency: 'INR', requestedCurrency: null });
    // The refusal never says which currencies the coupon does cover.
    expect(`${error.message} ${error.fix}`).not.toContain('USD');

    const buyer = await w.newBuyer();
    const refused = await buy({ couponCode: 'DOLLARS', country: 'IN' }, buyer);
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused)).toEqual(error);
    // Nothing was reserved, and the buyer can continue at full price.
    expect(await prisma.couponRedemption.count({ where: { applicationId: w.applicationId } })).toBe(0);
    const full = await buy({ country: 'IN' }, buyer);
    expect(full.json().data).toMatchObject({ currency: 'INR', unitAmount: 79900, discountAmount: 0 });
    expect(await redemptions('DOLLARS')).toBe(0);
  });

  it('refuses a percentage limited to other currencies the same way, and applies it where it is allowed', async () => {
    expect(errorOf(await preview({ code: 'PCTUSD', country: 'IN' }))).toMatchObject({
      code: 'COUPON_CURRENCY_NOT_COVERED',
      message: 'Coupon "PCTUSD" does not work for prices in INR.',
    });
    expect(errorOf(await buy({ couponCode: 'PCTUSD', country: 'IN' })).code).toBe('COUPON_CURRENCY_NOT_COVERED');
    expect(quoteOf(await preview({ code: 'PCTUSD' }))).toMatchObject({ currency: 'USD', discountAmount: 250 });
    // An unlimited percentage works in both.
    expect(quoteOf(await preview({ code: 'PCT', country: 'IN' }))).toMatchObject({ currency: 'INR', discountAmount: 19975 });
  });

  describe('after a fall back to the default price', () => {
    it('judges the coupon against the price charged', async () => {
      const res = await preview({ code: 'EURUSD', country: 'DE' });
      expect(quoteOf(res)).toMatchObject({ currency: 'USD', amount: 1000, discountAmount: 300, amountAfterDiscount: 700 });
      expect(res.json().data).toMatchObject({
        price: { currency: 'USD', amount: 1000, isDefault: true, reason: 'fallback' },
        priceFallback: { requested: { currency: 'EUR', amount: 900 }, charged: { currency: 'USD', amount: 1000 } },
        formatted: { discount: '$3.00', total: '$7.00' },
      });
      const bought = await buy({ couponCode: 'EURUSD', country: 'DE' });
      expect(bought.json().data).toMatchObject({ currency: 'USD', unitAmount: 1000, discountAmount: 300, priceFallback: { requested: { currency: 'EUR' } } });
    });

    it('refuses a coupon that covers the local currency and not the default, naming both', async () => {
      const quoted = await preview({ code: 'EURONLY', country: 'DE' });
      expect(quoted.statusCode, quoted.body).toBe(400);
      const error = errorOf(quoted);
      expect(error.code).toBe('COUPON_CURRENCY_NOT_COVERED');
      expect(error.message).toBe(
        'Prices in EUR cannot be charged yet, so this purchase is charged in USD, and coupon "EURONLY" does not work for prices in USD.',
      );
      expect(error.details).toEqual({ chargedCurrency: 'USD', requestedCurrency: 'EUR' });
      expect(error.fix).toContain('Check out without `couponCode` to pay the full price in USD');
      expect(error.fix).toContain('adding an amount in USD to its `amounts`');

      const refused = await buy({ couponCode: 'EURONLY', country: 'DE' });
      expect(refused.statusCode).toBe(400);
      expect(errorOf(refused)).toEqual(error);
    });

    it('lets the operator follow the fix: adding the amount makes the same code work', async () => {
      const fixed = await w.operator('PATCH', '/coupons/EURONLY', {
        amounts: [{ currency: 'EUR', amountOff: 200 }, { currency: 'USD', amountOff: 250 }],
      });
      expect(fixed.statusCode, fixed.body).toBe(200);
      expect(quoteOf(await preview({ code: 'EURONLY', country: 'DE' }))).toMatchObject({ currency: 'USD', discountAmount: 250 });

      // And for a percentage, adding the currency to its list.
      expect(errorOf(await preview({ code: 'PCTUSD', country: 'IN' })).fix).toContain('adding INR to its `currencies`');
      await w.operator('PATCH', '/coupons/PCTUSD', { currencies: ['USD', 'INR'] });
      expect(quoteOf(await preview({ code: 'PCTUSD', country: 'IN' }))).toMatchObject({ currency: 'INR', discountAmount: 19975 });
    });

    it('follows the other half of the fix: the checkout without the code charges the full default price', async () => {
      const bought = await buy({ country: 'DE' });
      expect(bought.json().data).toMatchObject({ currency: 'USD', unitAmount: 1000, discountAmount: 0 });
    });
  });

  describe('a fixed amount larger than the price', () => {
    it('is capped at the price of a subscription, so the first period is free', async () => {
      const quoted = quoteOf(await preview({ code: 'BIG', planSlug: 'pro' }));
      expect(quoted).toMatchObject({ currency: 'USD', amount: 2000, discountAmount: 2000, amountAfterDiscount: 0 });
      const bought = await w.checkout({ couponCode: 'BIG' });
      expect(bought.json().data).toMatchObject({ currency: 'USD', unitAmount: 2000, discountAmount: 2000 });
    });

    it('is refused on a one-time purchase, which cannot be checked out for zero, here and at checkout', async () => {
      const quoted = await preview({ code: 'BIG' });
      const refused = await buy({ couponCode: 'BIG' });
      expect(refused.statusCode).toBe(400);
      expect(errorOf(refused).code).toBe('COUPON_FULL_DISCOUNT_UNSUPPORTED');
      expect(quoted.statusCode).toBe(400);
      expect(errorOf(quoted)).toEqual(errorOf(refused));
    });
  });

  it('quotes exactly what the checkout then charges, or refuses with the same code, for every coupon and country', async () => {
    for (const code of ['BOTH', 'DOLLARS', 'INRONLY', 'EURONLY', 'EURUSD', 'PCT', 'PCTUSD', 'BIG']) {
      for (const country of [undefined, 'IN', 'DE']) {
        const buyer = await w.newBuyer();
        const where = country === undefined ? {} : { country };
        const quoted = await preview({ code, ...where }, buyer);
        const bought = await buy({ couponCode: code, ...where }, buyer);
        const label = `${code} in ${country ?? 'no country'}`;
        expect(quoted.statusCode, label).toBe(bought.statusCode);
        if (bought.statusCode !== 200) {
          expect(errorOf(quoted).code, label).toBe(errorOf(bought).code);
          continue;
        }
        const quote = quoted.json().data as Quote;
        const charged = (await w.sessionOf(bought)).row;
        expect(
          { currency: quote.currency, unitAmount: quote.amount, discountAmount: quote.discountAmount, chargeAmount: quote.amountAfterDiscount },
          label,
        ).toEqual({ currency: charged.currency, unitAmount: charged.unitAmount, discountAmount: charged.discountAmount, chargeAmount: charged.chargeAmount });
      }
    }
  });

  describe('the billing log', () => {
    it('records each refusal of a known coupon with the currency that was to be charged', async () => {
      await preview({ code: 'DOLLARS', country: 'IN' });
      await buy({ couponCode: 'DOLLARS', country: 'IN' });
      const logged = await refusedEvents('COUPON_CURRENCY_NOT_COVERED');
      expect(logged).toHaveLength(2);
      expect(logged[0]).toMatchObject({
        tier: 'DIAGNOSTIC',
        actorType: 'END_USER',
        endUserId: w.buyer.id,
        currency: 'INR',
        data: { code: 'dollars', planSlug: 'pack', reasonCode: 'COUPON_CURRENCY_NOT_COVERED', chargedCurrency: 'INR' },
      });
      expect(logged[0]!.couponId).toEqual(expect.any(String));
    });

    it('records a refusal decided after the provider is known', async () => {
      await buy({ couponCode: 'BIG' });
      await expect.poll(() => refusedEvents('COUPON_FULL_DISCOUNT_UNSUPPORTED')).toHaveLength(1);
      expect((await refusedEvents('COUPON_FULL_DISCOUNT_UNSUPPORTED'))[0]).toMatchObject({ currency: 'USD', data: { planSlug: 'pack' } });
    });

    it('records nothing for a code that matches no coupon', async () => {
      const res = await preview({ code: 'NOSUCHCODE' });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('COUPON_NOT_FOUND');
      expect(await prisma.billingEvent.count({ where: { applicationId: w.applicationId, type: 'coupon.refused' } })).toBe(0);
    });
  });
});
