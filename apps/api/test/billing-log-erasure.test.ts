/**
 * An erased end user's billing events: the log stays append-only, a drain that
 * overlaps the erasure does not restore their country, and their data export
 * carries the events without the actor's id.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  drainBillingEventOutbox,
  enqueueBillingEvent,
  eraseEndUserFromBillingLog,
  recordBillingEvent,
} from '../src/modules/billing-log/index.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('billing log entries of an erased end user', () => {
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

  describe("an end user's billing events", () => {
    const IN_INDIA = { buyerCountry: 'IN', buyerCountrySource: 'hint' } as const;
    const USD_PRICE = { planPriceId: null, currency: 'USD', amount: 2000 };

    /** A refusal and a payment in the log, and a fallback still in the outbox, all about `buyer`. */
    const writeEvents = async (buyer: Buyer): Promise<{ outboxId: string }> => {
      const about = { applicationId: w.applicationId, endUserId: buyer.id, actor: { type: 'end_user', id: buyer.id } } as const;
      await recordBillingEvent(prisma, {
        ...about,
        type: 'checkout.refused',
        data: { planSlug: 'pro', code: 'BILLING_NO_PROVIDER_FOR_CURRENCY', requestedCurrency: 'INR', ...IN_INDIA },
      });
      await recordBillingEvent(prisma, {
        ...about,
        type: 'payment.recorded',
        paymentId: `pay_${buyer.id}`,
        planPriceId: w.inrPriceId,
        currency: 'INR',
        amount: 149900,
        data: { priceCharged: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 }, discountAmount: 0, providerPaymentId: 'pay_rzp_1', verification: 'verified' },
      });
      return enqueueBillingEvent({
        ...about,
        type: 'checkout.price_fallback',
        currency: 'USD',
        amount: 2000,
        data: { planSlug: 'pro', requested: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 }, charged: USD_PRICE, reason: 'no_provider_for_currency', ...IN_INDIA },
      });
    };
    const eventsOf = (buyer: Buyer) =>
      prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, endUserId: buyer.id }, orderBy: { seq: 'asc' } });
    const queuedData = async (outboxId: string) =>
      ((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: outboxId } })).payload as { data: Record<string, unknown>; endUserId: string });

    const expectCountryGoneAndMoneyKept = async (buyer: Buyer, outboxId: string): Promise<void> => {
      const [refused, paid] = await eventsOf(buyer);
      expect(refused!.data).toEqual({ planSlug: 'pro', code: 'BILLING_NO_PROVIDER_FOR_CURRENCY', requestedCurrency: 'INR', buyerCountry: null, buyerCountrySource: null });
      expect(paid).toMatchObject({ endUserId: buyer.id, paymentId: `pay_${buyer.id}`, planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 });
      expect(paid!.data).toMatchObject({ providerPaymentId: 'pay_rzp_1', priceCharged: { amount: 149900 } });
      const queued = await queuedData(outboxId);
      expect(queued.endUserId).toBe(buyer.id);
      expect(queued.data).toMatchObject({ planSlug: 'pro', charged: USD_PRICE, buyerCountry: null, buyerCountrySource: null });
    };
    const expectUntouched = async (buyer: Buyer, outboxId: string): Promise<void> => {
      expect((await eventsOf(buyer))[0]!.data).toMatchObject(IN_INDIA);
      expect((await queuedData(outboxId)).data).toMatchObject(IN_INDIA);
    };

    it.each([
      ['erasing', '?erasure=true'],
      ['deleting', ''],
    ])('lose where the buyer was on %s them, in the log and in the outbox, and keep the money', async (_how, query) => {
      const bystander = await w.newBuyer();
      const mine = await writeEvents(w.buyer);
      const theirs = await writeEvents(bystander);

      const res = await w.operator('DELETE', `/end-users/${w.buyer.id}${query}`);
      expect(res.statusCode, res.body).toBeLessThan(300);

      await expectCountryGoneAndMoneyKept(w.buyer, mine.outboxId);
      await expectUntouched(bystander, theirs.outboxId);
    });

    it('leave the log append-only for the rest of the transaction that erased them', async () => {
      await writeEvents(w.buyer);
      await expect(
        prisma.$transaction(async (tx) => {
          await eraseEndUserFromBillingLog(tx, { applicationId: w.applicationId, endUserId: w.buyer.id });
          await tx.billingEvent.updateMany({ where: { applicationId: w.applicationId }, data: { amount: 1 } });
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('do not get their country back from a drain that overlaps the erasure', async () => {
      await writeEvents(w.buyer);
      let drained: Promise<number> | undefined;
      await prisma.$transaction(async (tx) => {
        await eraseEndUserFromBillingLog(tx, { applicationId: w.applicationId, endUserId: w.buyer.id });
        drained = drainBillingEventOutbox();
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      expect(await drained).toBeGreaterThanOrEqual(1);
      const fallback = (await eventsOf(w.buyer)).find((event) => event.type === 'checkout.price_fallback');
      expect(fallback!.data).toMatchObject({ planSlug: 'pro', buyerCountry: null, buyerCountrySource: null });
    });

    it('are in their data export, without the id of whoever acted', async () => {
      await writeEvents(w.buyer);
      await recordBillingEvent(prisma, {
        applicationId: w.applicationId,
        endUserId: w.buyer.id,
        actor: { type: 'operator', id: 'operator_who_granted' },
        type: 'subscription.granted',
        data: { planSlug: 'pro', price: USD_PRICE },
      });
      const res = await w.operator('GET', `/end-users/${w.buyer.id}/export`);
      expect(res.statusCode, res.body).toBe(200);
      const { billingEvents } = res.json() as { billingEvents: Array<Record<string, unknown>> };
      expect(billingEvents.map((event) => event.type).sort()).toEqual(['checkout.refused', 'payment.recorded', 'subscription.granted']);
      expect(billingEvents.find((event) => event.type === 'payment.recorded')).toMatchObject({ currency: 'INR', amount: 149900, actorType: 'end_user' });
      expect(billingEvents.find((event) => event.type === 'checkout.refused')!.data).toMatchObject(IN_INDIA);
      expect(res.body).not.toContain('operator_who_granted');
    });
  });
});
