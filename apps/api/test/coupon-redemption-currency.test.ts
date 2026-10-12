/**
 * A coupon redemption records the currency its discount is in, and the
 * operator's coupon totals never add two currencies together.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

const BACKFILL = new URL(
  '../../../prisma/migrations/20261011023425_coupon_redemption_currency_backfill/migration.sql',
  import.meta.url,
);

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

  it('reports no currency for a coupon nobody redeemed, and does not count an open checkout', async () => {
    await openInr();
    expect(await stats()).toMatchObject({
      redemptionCount: 0,
      discountIssuedByCurrency: [],
    });
  });

  describe('backfill', () => {
    const statements = readFileSync(BACKFILL, 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((sql) => sql.trim())
      .filter((sql) => sql !== '');
    async function backfill(): Promise<void> {
      for (const sql of statements) await prisma.$executeRawUnsafe(sql);
    }

    it('places each old redemption once, and leaves a row that already has a currency alone', async () => {
      const fixed = await w.operator('POST', '/coupons', {
        code: 'TENINR',
        discountType: 'AMOUNT',
        amounts: [{ currency: 'inr', amountOff: 1000 }],
      });
      const fixedId = (fixed.json().data as { id: string }).id;
      const base = { applicationId: w.applicationId, endUserId: w.buyer.id, discountAmount: 100 };

      // A percent redemption whose session names the INR price.
      const inrSession = await openInr();
      await payInr(inrSession, 'pay_inr_4');
      // One whose session predates the price columns: the plan's own currency.
      const usdBuyer = await w.newBuyer();
      await buyUsd(usdBuyer, 'pi_usd_3');
      const usdSession = await prisma.checkoutSession.findFirstOrThrow({ where: { endUserId: usdBuyer.id } });
      await prisma.checkoutSession.update({ where: { id: usdSession.id }, data: { currency: null, unitAmount: null } });
      await prisma.couponRedemption.updateMany({ where: { couponId: halfId }, data: { currency: null } });

      const viaSubscription = await prisma.couponRedemption.create({
        data: { ...base, couponId: halfId, subscriptionId: usdSession.subscriptionId, checkoutSessionId: 'cs_gone' },
      });
      const unplaceable = await prisma.couponRedemption.create({ data: { ...base, couponId: halfId } });
      const fixedRow = await prisma.couponRedemption.create({ data: { ...base, couponId: fixedId } });
      const alreadySet = await prisma.couponRedemption.create({
        data: { ...base, couponId: fixedId, currency: 'GBP', checkoutSessionId: 'cs_kept' },
      });

      await backfill();
      const currencyOf = async (where: { id: string } | { checkoutSessionId: string }) =>
        (await prisma.couponRedemption.findFirstOrThrow({ where })).currency;
      expect(await currencyOf({ checkoutSessionId: inrSession })).toBe('INR');
      expect(await currencyOf({ checkoutSessionId: usdSession.providerSessionId })).toBe('USD');
      expect(await currencyOf({ id: viaSubscription.id })).toBe('USD');
      expect(await currencyOf({ id: unplaceable.id })).toBeNull();
      expect(await currencyOf({ id: fixedRow.id })).toBe('INR');
      expect(await currencyOf({ id: alreadySet.id })).toBe('GBP');

      // A second run changes nothing.
      const before = await prisma.couponRedemption.findMany({ orderBy: { id: 'asc' } });
      await backfill();
      expect(await prisma.couponRedemption.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    });
  });
});
