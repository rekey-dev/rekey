/**
 * An Application or a Tenant can be deleted while payments and credit grants
 * still name its price rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  recordBillingEvent,
} from '../src/modules/billing-log/index.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('deleting the owner of billing records', () => {
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

  /** Put `buyer` on `pro` in INR through Razorpay, as a completed checkout would. */
  const subscribeInInr = async (buyer: Buyer): Promise<void> => {
    const sub = await prisma.subscription.create({
      data: {
        applicationId: w.applicationId,
        endUserId: buyer.id,
        planId: w.planId,
        status: 'ACTIVE',
        provider: 'razorpay',
        providerSubId: `sub_inr_${buyer.id}`,
      },
    });
    await prisma.$executeRaw`UPDATE "subscriptions" SET "currency" = 'INR', "unit_amount" = 149900, "plan_price_id" = ${w.inrPriceId} WHERE "id" = ${sub.id}`;
  };

  describe('deleting what owns billing records', () => {
    /** A subscription and a credit grant on a price row, a payment on that row, a refund of it, and an event. */
    const sell = async (): Promise<void> => {
      await subscribeInInr(w.buyer);
      const payment = await prisma.payment.create({
        data: { applicationId: w.applicationId, endUserId: w.buyer.id, amount: 149900, currency: 'INR', status: 'SUCCEEDED', planPriceId: w.inrPriceId, unitAmount: 149900, provider: 'razorpay' },
      });
      await prisma.refund.create({
        data: { applicationId: w.applicationId, paymentId: payment.id, amount: 1000, currency: 'INR', status: 'SUCCEEDED', initiatedBy: 'OPERATOR' },
      });
      await prisma.creditLedger.create({
        data: { applicationId: w.applicationId, endUserId: w.buyer.id, subjectKey: `user:${w.buyer.id}`, delta: 100, reason: 'PURCHASE', balanceAfter: 100, paymentId: payment.id, planPriceId: w.inrPriceId },
      });
      await recordBillingEvent(prisma, {
        applicationId: w.applicationId,
        endUserId: w.buyer.id,
        actor: { type: 'provider' },
        type: 'payment.recorded',
        paymentId: payment.id,
        planPriceId: w.inrPriceId,
        currency: 'INR',
        amount: 149900,
        data: { priceCharged: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 }, discountAmount: 0, providerPaymentId: null, verification: 'verified' },
      });
    };
    const left = async () => ({
      prices: await prisma.planPrice.count({ where: { applicationId: w.applicationId } }),
      payments: await prisma.payment.count({ where: { applicationId: w.applicationId } }),
      refunds: await prisma.refund.count({ where: { applicationId: w.applicationId } }),
      subscriptions: await prisma.subscription.count({ where: { applicationId: w.applicationId } }),
      ledger: await prisma.creditLedger.count({ where: { applicationId: w.applicationId } }),
      events: await prisma.billingEvent.count({ where: { applicationId: w.applicationId } }),
    });
    const NOTHING = { prices: 0, payments: 0, refunds: 0, subscriptions: 0, ledger: 0, events: 0 };

    it('an Application goes, with payments and credit grants that name its price rows', async () => {
      await sell();
      expect((await left()).payments).toBe(1);
      await prisma.application.delete({ where: { id: w.applicationId } });
      expect(await left()).toEqual(NOTHING);
    });

    it('a Tenant goes likewise', async () => {
      await sell();
      const { tenantId } = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
      expect(await left()).toEqual(NOTHING);
    });
  });
});
