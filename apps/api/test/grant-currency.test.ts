/**
 * A subscription created with no checkout takes the plan's price in the
 * currency its creator names: an operator grant, an external activation, or
 * the first payment an external system reports.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const UNPRICED = { currency: null, unitAmount: null, planPriceId: null };

describe('price of a subscription no checkout created', () => {
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
  });

  const defaultPriceIdOf = async (): Promise<string> => {
    const { defaultPriceId } = await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } });
    expect(defaultPriceId).not.toBeNull();
    return defaultPriceId!;
  };
  const subscriptionOf = (endUserId: string) =>
    prisma.subscription.findFirst({ where: { applicationId: w.applicationId, endUserId } });

  describe('operator grant', () => {
    const grant = (body: Record<string, unknown> = {}, endUserId = w.buyer.id) =>
      w.operator('POST', `/end-users/${endUserId}/subscriptions`, { planSlug: 'pro', ...body });

    it('takes the additional price in the currency named, and says so in the response', async () => {
      const res = await grant({ currency: 'inr' });
      expect(res.statusCode, res.body).toBe(201);
      const priced = { currency: 'INR', unitAmount: 149900, planPriceId: w.inrPriceId };
      expect(res.json().data.subscription).toMatchObject({ status: 'ACTIVE', ...priced });
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(priced);
    });

    it('refuses a currency the plan has no price in, naming the ones it has, and grants nothing', async () => {
      const res = await grant({ currency: 'EUR' });
      expect(res.statusCode).toBe(400);
      const error = res.json().error as { code: string; message: string; fix: string };
      expect(error.code).toBe('BILLING_PLAN_CURRENCY_UNAVAILABLE');
      expect(error.message).toContain('EUR');
      expect(error.fix).toContain('(USD, INR)');
      expect(error.fix).toContain(`/api/v1/tenant/applications/${w.applicationId}/plans/pro/prices/EUR`);
      expect(await subscriptionOf(w.buyer.id)).toBeNull();

      // The remedy the refusal names is real: add the price, grant again.
      await w.putPrice('pro', 'EUR', 1800);
      expect((await grant({ currency: 'EUR' })).statusCode).toBe(201);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({ currency: 'EUR', unitAmount: 1800 });
    });

    it('takes the plan default price when no currency is named', async () => {
      const res = await grant();
      expect(res.statusCode, res.body).toBe(201);
      const priced = { status: 'ACTIVE', currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceIdOf() };
      expect(res.json().data.subscription).toMatchObject(priced);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(priced);
    });

    it('gives a lapsed row that had no price the default when no currency is named', async () => {
      await prisma.subscription.create({
        data: { applicationId: w.applicationId, endUserId: w.buyer.id, planId: w.planId, status: 'CANCELED' },
      });
      expect((await grant()).statusCode).toBe(201);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({
        status: 'ACTIVE',
        currency: 'USD',
        unitAmount: 2000,
        planPriceId: await defaultPriceIdOf(),
      });
    });

    it('leaves a subscription to a free plan without a price', async () => {
      await w.createPlan({ slug: 'free', name: 'Free', });
      expect((await grant({ planSlug: 'free' })).statusCode).toBe(201);
      const row = await prisma.subscription.findFirstOrThrow({ where: { endUserId: w.buyer.id, plan: { slug: 'free' } } });
      expect(row).toMatchObject({ status: 'ACTIVE', ...UNPRICED });
    });

    it('a lapsed row takes the price named, replacing the one it lapsed at', async () => {
      const defaultPriceId = await defaultPriceIdOf();
      await prisma.subscription.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          planId: w.planId,
          status: 'CANCELED',
          currency: 'USD',
          unitAmount: 1234,
          planPriceId: defaultPriceId,
        },
      });
      const res = await grant({ currency: 'INR' });
      expect(res.statusCode, res.body).toBe(201);
      const priced = { status: 'ACTIVE', currency: 'INR', unitAmount: 149900, planPriceId: w.inrPriceId };
      expect(res.json().data.subscription).toMatchObject(priced);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(priced);
    });

    it('a lapsed row keeps its price when no currency is named', async () => {
      await prisma.subscription.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          planId: w.planId,
          status: 'CANCELED',
          currency: 'INR',
          unitAmount: 99900,
          planPriceId: w.inrPriceId,
        },
      });
      expect((await grant()).statusCode).toBe(201);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({
        status: 'ACTIVE',
        currency: 'INR',
        unitAmount: 99900,
        planPriceId: w.inrPriceId,
      });
    });

    it('refuses to change the currency of a live subscription, and says the subscriber keeps theirs', async () => {
      expect((await grant({ currency: 'INR' })).statusCode).toBe(201);
      const res = await grant({ currency: 'USD' });
      expect(res.statusCode, res.body).toBe(409);
      const error = res.json().error as { code: string; message: string; fix: string };
      expect(error.code).toBe('BILLING_SUBSCRIPTION_CURRENCY_KEPT');
      expect(error.message).toContain('keeps their currency');
      expect(error.message).toContain('INR');
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({ status: 'ACTIVE', currency: 'INR', unitAmount: 149900 });

      // Both remedies the refusal names: confirm it as it stands, or cancel and grant again.
      expect((await grant()).statusCode).toBe(200);
      expect((await grant({ currency: 'inr' })).statusCode).toBe(200);
      await prisma.subscription.updateMany({ where: { endUserId: w.buyer.id }, data: { status: 'CANCELED' } });
      expect((await grant({ currency: 'USD' })).statusCode).toBe(201);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({
        currency: 'USD',
        unitAmount: 2000,
        planPriceId: await defaultPriceIdOf(),
      });
    });

    it('does not price a live subscription a checkout opened: it refuses another currency instead', async () => {
      await prisma.subscription.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          planId: w.planId,
          status: 'ACTIVE',
          metadata: { checkoutSessionId: 'cs_open' },
        },
      });
      // No currency is recorded for it, the plan's default included, so naming
      // any is refused and confirming it as it stands is not.
      for (const currency of ['INR', 'USD']) {
        const refused = await grant({ currency });
        expect(refused.statusCode, refused.body).toBe(409);
        const error = refused.json().error as { code: string; message: string; fix: string };
        expect(error.code).toBe('BILLING_SUBSCRIPTION_PRICE_UNSETTLED');
        expect(error.message).toContain(currency);
        expect(error.fix).toContain('Omit `currency`');
      }
      expect((await grant()).statusCode).toBe(200);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(UNPRICED);
    });

    it('a grant that names no currency prices a live subscription that had no price, at the default, and logs it', async () => {
      await prisma.subscription.create({
        data: { applicationId: w.applicationId, endUserId: w.buyer.id, planId: w.planId, status: 'ACTIVE' },
      });
      const res = await grant();
      expect(res.statusCode, res.body).toBe(200);
      const priced = { currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceIdOf() };
      expect(res.json().data.subscription).toMatchObject(priced);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(priced);

      const log = await w.operator('GET', '/billing/events?type=subscription.priced');
      expect(log.statusCode, log.body).toBe(200);
      const [entry] = (log.json().data as { items: Array<{ actor: { type: string }; data: Record<string, unknown> }> }).items;
      expect(entry).toMatchObject({
        actor: { type: 'operator' },
        data: { before: null, after: { currency: 'USD', amount: 2000 }, cause: 'grant' },
      });
    });

  });

  describe('external billing system', () => {
    const activate = (id: string, subscription: Record<string, unknown> = {}, endUserId = w.buyer.id) =>
      w.externalEvent('subscription.activated', {
        subscription: { id, plan: 'pro', ...subscription },
        subscriber: { endUserId },
      });
    const pay = (subscriptionId: string, id: string, amount: number, currency: string) =>
      w.externalEvent('payment.succeeded', { payment: { id, subscriptionId, amount, currency } });
    const atDefault = async () => ({ currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceIdOf() });
    const receiptOf = (eventId: string) =>
      prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: w.applicationId, providerEventId: eventId } });

    it('an activation that names a currency takes the matching price', async () => {
      const { res } = await activate('ext_1', { currency: 'inr' });
      expect(res.statusCode, res.body).toBe(200);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({
        status: 'ACTIVE',
        provider: 'external',
        currency: 'INR',
        unitAmount: 149900,
        planPriceId: w.inrPriceId,
      });
    });

    it('an activation in a currency the plan has no price in is still applied, at the default price, and noted', async () => {
      const { res, eventId } = await activate('ext_2', { currency: 'EUR' });
      expect(res.statusCode, res.body).toBe(200);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({ status: 'ACTIVE', ...(await atDefault()) });
      const receipt = await receiptOf(eventId);
      expect(receipt.processedAt).not.toBeNull();
      expect(receipt.processingError).toContain('has no price in EUR');
      expect(receipt.processingError).toContain('USD, INR');
    });

    it('an activation that names no currency takes the default price', async () => {
      const { res, eventId } = await activate('ext_3');
      expect(res.statusCode, res.body).toBe(200);
      const sub = (await subscriptionOf(w.buyer.id))!;
      expect(sub).toMatchObject({ status: 'ACTIVE', ...(await atDefault()) });
      expect((await receiptOf(eventId)).processingError).toBeNull();
      // The activation and the price it took are both in the billing log.
      const logged = await prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, subscriptionId: sub.id }, orderBy: { seq: 'asc' } });
      expect(logged.map((e) => e.type)).toEqual(['subscription.priced', 'subscription.activated']);
      expect(logged[0]).toMatchObject({ currency: 'USD', amount: 2000, actorType: 'PROVIDER', provider: 'external', providerEventId: eventId });
      expect(logged[0]!.data).toMatchObject({ before: null, after: { currency: 'USD', amount: 2000 }, cause: 'provider' });
      expect(logged[1]!.data).toMatchObject({ via: 'provider', price: { currency: 'USD', amount: 2000 } });
    });

    it('a later activation re-prices a row nobody has paid at, and never one somebody has', async () => {
      await activate('ext_4');
      await activate('ext_4', { currency: 'INR' });
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({ currency: 'INR', unitAmount: 149900, planPriceId: w.inrPriceId });
      await pay('ext_4', 'pay_ext_0', 149900, 'INR');
      await activate('ext_4', { currency: 'USD' });
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({ currency: 'INR', unitAmount: 149900 });
    });

    it('the first payment re-prices a subscription nobody had paid at, in the currency it was paid in, and is verified', async () => {
      await activate('ext_5');
      const { res } = await pay('ext_5', 'pay_ext_1', 149900, 'INR');
      expect(res.statusCode, res.body).toBe(200);
      const sub = (await subscriptionOf(w.buyer.id))!;
      expect(await prisma.payment.findMany({ where: { applicationId: w.applicationId } })).toMatchObject([
        { providerPaymentId: 'pay_ext_1', amount: 149900, currency: 'INR', status: 'SUCCEEDED', verification: 'VERIFIED', subscriptionId: sub.id, planPriceId: w.inrPriceId, unitAmount: 149900 },
      ]);
      expect(sub).toMatchObject({ currency: 'INR', unitAmount: 149900, planPriceId: w.inrPriceId });
      const repriced = await prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, type: 'subscription.priced' }, orderBy: { seq: 'asc' } });
      expect(repriced.map((e) => e.data)).toMatchObject([
        { before: null, after: { currency: 'USD', amount: 2000 }, cause: 'provider' },
        { before: { currency: 'USD', amount: 2000 }, after: { currency: 'INR', amount: 149900 }, cause: 'first_payment' },
      ]);

      // The price is the subscriber's from here on: a later USD charge
      // mismatches. It is recorded, unverified, and the receipt says why.
      const later = await pay('ext_5', 'pay_ext_2', 2000, 'USD');
      const mismatched = await prisma.payment.findFirstOrThrow({ where: { applicationId: w.applicationId, providerPaymentId: 'pay_ext_2' }, include: { unapplied: true } });
      expect(mismatched).toMatchObject({ amount: 2000, currency: 'USD', verification: 'UNVERIFIED', subscriptionId: null, planPriceId: null });
      expect(mismatched.unapplied).toMatchObject({ status: 'OPEN' });
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({ currency: 'INR', unitAmount: 149900 });
      const note = (await receiptOf(later.eventId)).processingError;
      expect(note).toContain('"pay_ext_2" is in USD');
      expect(note).toContain('priced in INR');
      expect(note).toContain('recorded as unverified');
    });

    it('a payment in a currency the plan has no price in is recorded unverified, prices nothing, and is noted', async () => {
      await activate('ext_6');
      const { res, eventId } = await pay('ext_6', 'pay_ext_3', 1800, 'EUR');
      expect(res.statusCode, res.body).toBe(200);
      const recorded = await prisma.payment.findMany({ where: { applicationId: w.applicationId }, include: { unapplied: true } });
      expect(recorded).toMatchObject([
        { providerPaymentId: 'pay_ext_3', amount: 1800, currency: 'EUR', verification: 'UNVERIFIED', subscriptionId: null, endUserId: w.buyer.id, unapplied: { status: 'OPEN' } },
      ]);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(await atDefault());
      expect((await receiptOf(eventId)).processingError).toContain('"pay_ext_3" is in EUR');
      const events = await prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, paymentId: recorded[0]!.id }, orderBy: { seq: 'asc' } });
      expect(events.map((e) => e.type)).toEqual(['payment.recorded', 'payment.not_applied']);
      expect(events[0]!.data).toMatchObject({ verification: 'unverified', priceCharged: null });
      expect(events[1]!.data).toMatchObject({ reason: 'currency_mismatch', expected: { currency: 'USD', amount: 2000 } });
    });

    it('an unverified payment prices nothing, so the next payment in the default currency is verified', async () => {
      await activate('ext_7');
      const refused = await pay('ext_7', 'pay_ext_4', 149900 * 100, 'INR');
      expect(refused.res.statusCode, refused.res.body).toBe(200);
      expect(await prisma.payment.findMany({ where: { applicationId: w.applicationId } })).toMatchObject([
        { providerPaymentId: 'pay_ext_4', verification: 'UNVERIFIED', subscriptionId: null },
      ]);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(await atDefault());
      expect((await receiptOf(refused.eventId)).processingError).toContain('100 times the price');

      await pay('ext_7', 'pay_ext_5', 2000, 'USD');
      expect(await prisma.payment.findFirstOrThrow({ where: { applicationId: w.applicationId, providerPaymentId: 'pay_ext_5' } })).toMatchObject({
        amount: 2000,
        currency: 'USD',
        status: 'SUCCEEDED',
        verification: 'VERIFIED',
      });
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(await atDefault());
    });

    it('a replay of a payment already recorded prices nothing', async () => {
      await activate('ext_8');
      await prisma.payment.create({
        data: {
          applicationId: w.applicationId,
          amount: 149900,
          currency: 'INR',
          status: 'SUCCEEDED',
          providerPaymentId: 'pay_ext_6',
        },
      });
      const { res } = await pay('ext_8', 'pay_ext_6', 149900, 'INR');
      expect(res.statusCode, res.body).toBe(200);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject(await atDefault());
    });

    it('an activation does not price a live subscription a checkout opened', async () => {
      await prisma.subscription.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          planId: w.planId,
          status: 'ACTIVE',
          metadata: { checkoutSessionId: 'cs_open' },
        },
      });
      const { res } = await activate('ext_9', { currency: 'INR' });
      expect(res.statusCode, res.body).toBe(200);
      expect(await subscriptionOf(w.buyer.id)).toMatchObject({ provider: 'external', ...UNPRICED });
    });
  });

  it('a payment does not price a subscription a checkout opened: the checkout does', async () => {
    const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
    const hook = await w.razorpayWebhook({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: row.providerSessionId, status: 'active', paid_count: 1 } },
        payment: { entity: { id: 'pay_rzp_first', amount: 149900, currency: 'INR' } },
      },
    });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(await prisma.payment.count({ where: { applicationId: w.applicationId } })).toBe(1);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } })).toMatchObject(UNPRICED);
  });
});
