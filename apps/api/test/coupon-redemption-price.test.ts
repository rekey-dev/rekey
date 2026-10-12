/**
 * What a redemption records (the currency charged, the amount taken, the
 * price row), how totals are reported (per currency, never added), and that
 * a coupon's limits hold when eight buyers reach for it at once, whatever
 * currency each of them pays in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

interface CouponStats {
  code: string;
  redemptionCount: number;
  discountIssuedByCurrency: Array<{ currency: string; amount: number; redemptions: number }>;
}

describe('coupon redemptions', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;
  let usdPackPriceId: string;
  let inrPackPriceId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
    const packId = await w.createPlan({ slug: 'pack', name: '100 credits', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 100 });
    await w.putPrice('pack', 'INR', 79900);
    const prices = await prisma.planPrice.findMany({ where: { planId: packId } });
    usdPackPriceId = prices.find((p) => p.currency === 'USD')!.id;
    inrPackPriceId = prices.find((p) => p.currency === 'INR')!.id;
  });

  async function createCoupon(body: Record<string, unknown>): Promise<string> {
    const res = await w.operator('POST', '/coupons', body);
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { id: string }).id;
  }
  async function stats(code: string): Promise<CouponStats> {
    const res = await w.operator('GET', '/coupons');
    return (res.json().data as { items: CouponStats[] }).items.find((c) => c.code === code)!;
  }
  /** Buy the pack in India through Razorpay with `code`, and settle it. */
  async function buyInr(buyer: Buyer, code: string, paymentId: string, paid: number): Promise<void> {
    const { row } = await w.sessionOf(await w.checkout({ planSlug: 'pack', country: 'IN', couponCode: code }, { buyer }));
    const hook = await w.razorpayWebhook({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: row.providerSessionId } },
        payment: { entity: { id: paymentId, amount: paid, currency: 'INR' } },
      },
    });
    expect(hook.statusCode, hook.body).toBe(200);
  }
  /** Buy the pack at the default USD price through Stripe with `code`, and settle it. */
  async function buyUsd(buyer: Buyer, code: string, paymentId: string, paid: number): Promise<void> {
    const { row } = await w.sessionOf(await w.checkout({ planSlug: 'pack', couponCode: code }, { buyer }));
    await applyBillingEvent(
      {
        type: 'checkout.completed',
        providerEventId: `evt_${paymentId}`,
        applicationId: w.applicationId,
        checkoutSessionId: row.providerSessionId,
        providerSubscriptionId: null,
        payment: { providerPaymentId: paymentId, amount: paid, currency: 'usd', description: null },
        raw: {},
      },
      { log: app.log, provider: 'stripe' },
    );
  }

  it('records the currency charged, the amount taken and the price row, for each currency of a fixed coupon', async () => {
    const couponId = await createCoupon({
      code: 'BOTH',
      discountType: 'AMOUNT',
      amounts: [{ currency: 'USD', amountOff: 300 }, { currency: 'INR', amountOff: 20000 }],
    });
    const [indian, american] = [await w.newBuyer(), await w.newBuyer()];
    await buyInr(indian, 'BOTH', 'pay_inr_1', 59900);
    await buyUsd(american, 'BOTH', 'pi_usd_1', 700);

    // The price row is on no response yet, so it is read from the table.
    const rows = await prisma.couponRedemption.findMany({ where: { couponId }, orderBy: { currency: 'asc' } });
    expect(rows).toMatchObject([
      { status: 'CONFIRMED', endUserId: indian.id, currency: 'INR', discountAmount: 20000, planPriceId: inrPackPriceId },
      { status: 'CONFIRMED', endUserId: american.id, currency: 'USD', discountAmount: 300, planPriceId: usdPackPriceId },
    ]);

    // One row per currency, and nothing that adds rupees to dollars.
    const reported = await stats('both');
    expect(reported).toMatchObject({
      redemptionCount: 2,
      discountIssuedByCurrency: [
        { currency: 'USD', amount: 300, redemptions: 1 },
        { currency: 'INR', amount: 20000, redemptions: 1 },
      ],
    });
    expect(JSON.stringify(reported)).not.toContain('20300');
  });

  it('holds the price row on the reservation from the moment the checkout opens', async () => {
    const couponId = await createCoupon({ code: 'PCT', discountType: 'PERCENT', basisPoints: 2500 });
    await w.sessionOf(await w.checkout({ planSlug: 'pack', country: 'IN', couponCode: 'PCT' }));
    expect(await prisma.couponRedemption.findMany({ where: { couponId } })).toMatchObject([
      { status: 'RESERVED', currency: 'INR', discountAmount: 19975, planPriceId: inrPackPriceId },
    ]);
    // An open checkout is not a redemption.
    expect(await stats('pct')).toMatchObject({ redemptionCount: 0, discountIssuedByCurrency: [] });
  });

  it('writes one coupon.redeemed event with the price charged, once, however often the payment is replayed', async () => {
    const couponId = await createCoupon({ code: 'PCT', discountType: 'PERCENT', basisPoints: 2500 });
    const buyer = await w.newBuyer();
    await buyInr(buyer, 'PCT', 'pay_inr_2', 59925);
    const session = await prisma.checkoutSession.findFirstOrThrow({ where: { endUserId: buyer.id } });
    // The provider delivers the same payment again.
    await w.razorpayWebhook({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: session.providerSessionId } },
        payment: { entity: { id: 'pay_inr_2', amount: 59925, currency: 'INR' } },
      },
    });

    const logged = await prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, type: 'coupon.redeemed' } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      tier: 'PERMANENT',
      actorType: 'END_USER',
      endUserId: buyer.id,
      couponId,
      planPriceId: inrPackPriceId,
      currency: 'INR',
      amount: 19975,
      data: {
        code: 'pct',
        planSlug: 'pack',
        discountAmount: 19975,
        priceCharged: { planPriceId: inrPackPriceId, currency: 'INR', amount: 79900 },
      },
    });
    expect(await stats('pct')).toMatchObject({ redemptionCount: 1 });
  });

  describe('eight buyers at once on a single-use coupon', () => {
    const RACERS = 8;

    async function race(code: string, countryOf: (index: number) => string | undefined) {
      const buyers = await Promise.all(Array.from({ length: RACERS }, () => w.newBuyer()));
      const results = await Promise.all(
        buyers.map((buyer, index) => {
          const country = countryOf(index);
          return w.checkout({ planSlug: 'pack', couponCode: code, ...(country !== undefined && { country }) }, { buyer });
        }),
      );
      return {
        won: results.filter((res) => res.statusCode === 200),
        lost: results.filter((res) => res.statusCode !== 200),
      };
    }

    it('lets exactly one check out, and refuses the other seven with the limit code', async () => {
      const couponId = await createCoupon({ code: 'ONCE', discountType: 'PERCENT', basisPoints: 2500, maxRedemptions: 1 });
      const { won, lost } = await race('ONCE', () => undefined);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(RACERS - 1);
      for (const res of lost) {
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('COUPON_REDEMPTION_LIMIT_REACHED');
      }
      expect(await prisma.couponRedemption.count({ where: { couponId } })).toBe(1);
    });

    it('counts the limit across currencies: half the buyers pay rupees, half dollars, one wins', async () => {
      const couponId = await createCoupon({
        code: 'ONCEBOTH',
        discountType: 'AMOUNT',
        amounts: [{ currency: 'USD', amountOff: 300 }, { currency: 'INR', amountOff: 20000 }],
        maxRedemptions: 1,
      });
      const { won, lost } = await race('ONCEBOTH', (index) => (index % 2 === 0 ? 'IN' : undefined));
      expect(won).toHaveLength(1);
      expect(lost.map((res) => res.json().error.code)).toEqual(Array(RACERS - 1).fill('COUPON_REDEMPTION_LIMIT_REACHED'));
      expect(await prisma.couponRedemption.count({ where: { couponId } })).toBe(1);
    });
  });
});
