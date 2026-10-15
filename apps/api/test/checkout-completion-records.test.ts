/**
 * What a completed checkout records: the session's charge and discount, the
 * payment's price, provider and verification, and the subscription priced in
 * the currency the session charged.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { completeCheckoutSession } from '../src/modules/billing/checkout/sessions.service.js';

const markCheckoutSessionComplete = (applicationId: string, providerSessionId: string) =>
  prisma.$transaction((tx) => completeCheckoutSession(tx, applicationId, providerSessionId, { actor: { type: 'system' } }));
import { toProviderAmount as paypalWire } from '../src/modules/billing/providers/paypal-money.js';
import { toProviderAmount as stripeWire } from '../src/modules/billing/providers/stripe-money.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('checkout completion records', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  describe('what a checkout and a payment record', () => {
    it('writes the session charge and discount, and the payment price, provider and verification', async () => {
      const coupon = await w.operator('POST', '/coupons', { code: 'TENPCT', discountType: 'PERCENT', basisPoints: 1000 });
      expect(coupon.statusCode, coupon.body).toBe(201);
      await w.createPlan({ slug: 'pack', name: 'Pack', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 10 });
      const { row } = await w.sessionOf(await w.checkout({ planSlug: 'pack', couponCode: 'TENPCT' }));
      expect(row).toMatchObject({ unitAmount: 1000, discountAmount: 100, chargeAmount: 900 });

      const plain = await w.sessionOf(await w.checkout({}, { buyer: await w.newBuyer() }));
      expect(plain.row).toMatchObject({ unitAmount: 2000, discountAmount: 0, chargeAmount: 2000 });
    });
  });

  describe('a percentage coupon on a currency charged in whole units', () => {
    it.each([
      ['HUF', paypalWire],
      ['MGA', stripeWire],
      ['TWD', paypalWire],
    ] as const)('quotes and charges a %s discount every provider can take, the same on the page and at checkout', async (currency, toWire) => {
      await prisma.billingCredentials.updateMany({ where: { applicationId: w.applicationId, provider: 'stripe' }, data: { currencies: ['USD', currency] } });
      await w.createPlan({ slug: 'local', name: 'Local', price: { currency: currency, amount: 499000 }, kind: 'CREDIT', creditsAmount: 10 });
      const coupon = await w.operator('POST', '/coupons', { code: 'PCT15', discountType: 'PERCENT', basisPoints: 1500 });
      expect(coupon.statusCode, coupon.body).toBe(201);

      // 15% is 74850, which is not a whole unit. Rounded up for the buyer: 74900.
      const preview = await w.asBuyer('POST', '/coupons/validate', { code: 'PCT15', planSlug: 'local' });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().data).toMatchObject({ currency, amount: 499000, discountAmount: 74900, amountAfterDiscount: 424100 });

      const bought = await w.checkout({ planSlug: 'local', couponCode: 'PCT15' });
      const { row } = await w.sessionOf(bought);
      expect(bought.json().data.discountAmount).toBe(74900);
      expect(row).toMatchObject({ currency, unitAmount: 499000, discountAmount: 74900, chargeAmount: 424100 });

      // What a provider is sent for the discount and for what is left: neither is refused.
      expect(() => toWire(currency, 74900)).not.toThrow();
      expect(() => toWire(currency, 424100)).not.toThrow();
      // The figure the old rounding produced is the one a provider refuses.
      expect(() => toWire(currency, 74850)).toThrow();
    });
  });

  describe('completeCheckoutSession', () => {
    it('leaves a subscription of another Application alone, whatever the session row names', async () => {
      const other = await twoCurrencyWorld(app);
      const victim = await prisma.subscription.create({
        data: { applicationId: other.applicationId, endUserId: other.buyer.id, planId: other.planId, status: 'ACTIVE' },
      });
      await prisma.checkoutSession.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          subscriptionId: victim.id,
          provider: 'stripe',
          providerSessionId: 'cs_cross_app',
          mode: 'REDIRECT',
          paymentMode: 'TEST',
          kind: 'RECURRING',
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/no',
          currency: 'USD',
          unitAmount: 1,
          expiresAt: new Date(Date.now() + 3_600_000),
          metadata: {},
        },
      });
      await markCheckoutSessionComplete(w.applicationId, 'cs_cross_app');
      expect(await prisma.subscription.findUniqueOrThrow({ where: { id: victim.id } })).toMatchObject({
        currency: null,
        unitAmount: null,
        planPriceId: null,
      });
    });
  });

  describe('a checkout completing', () => {
    it('prices the subscription in the currency the session charged, even after the plan default moved to another', async () => {
      const subscription = await prisma.subscription.create({
        data: { applicationId: w.applicationId, endUserId: w.buyer.id, planId: w.planId, status: 'PENDING' },
      });
      // A session opened at the default price when that was EUR 18.00. The default is USD now.
      await prisma.checkoutSession.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          subscriptionId: subscription.id,
          provider: 'stripe',
          providerSessionId: 'cs_eur_then',
          mode: 'REDIRECT',
          paymentMode: 'TEST',
          kind: 'RECURRING',
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/no',
          currency: 'EUR',
          unitAmount: 1800,
          expiresAt: new Date(Date.now() + 3_600_000),
          metadata: {},
        },
      });
      await markCheckoutSessionComplete(w.applicationId, 'cs_eur_then');
      const priced = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(priced).toMatchObject({ currency: 'EUR', unitAmount: 1800 });
      const row = await prisma.planPrice.findUniqueOrThrow({ where: { id: priced.planPriceId! } });
      expect(row).toMatchObject({ planId: w.planId, currency: 'EUR' });
      expect(row.archivedAt).not.toBeNull();
    });
  });
});
