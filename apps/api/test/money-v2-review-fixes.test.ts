/**
 * Fixes from the second review of the money model foundation, each held at
 * the wire where there is one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import {
  drainBillingEventOutbox,
  enqueueBillingEvent,
  eraseEndUserFromBillingLog,
  pollBillingEventOutbox,
  recordBillingEvent,
} from '../src/modules/billing-log/index.js';
import { countQueries } from './query-counter.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

type CataloguePlan = {
  slug: string;
  checkout: { ready: boolean };
  price: { currency: string; amount: number; reason: string } | null;
};

describe('money model foundation: second review', () => {
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

  const razorpayCharges = (currencies: string[]) =>
    billingCredentialsService.upsertRaw(
      w.applicationId,
      'razorpay',
      { keyId: 'rzp_test_ci', keySecret: 'secret_ci_only', webhookSecret: 'rzp_whsec_two_currency' },
      { mode: 'test', enabled: true, currencies, countries: ['IN'], priority: 50 },
    );

  describe('GET /billing/plans for a buyer whose provider can no longer charge their currency', () => {
    const catalogue = async (opts: { key?: string; buyer?: Buyer } = {}): Promise<CataloguePlan[]> => {
      const res = await w.asBuyer('GET', '/plans', undefined, opts);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().data as { items: CataloguePlan[] }).items;
    };

    beforeEach(async () => {
      await w.createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
      await w.putPrice('team', 'INR', 399900);
      await subscribeInInr(w.buyer);
      await razorpayCharges(['USD']);
    });

    it('answers with the price they are bound to and says they cannot check out', async () => {
      for (const key of [w.secretKey, w.publishableKey]) {
        const plans = await catalogue({ key });
        expect(plans.find((plan) => plan.slug === 'team')).toMatchObject({
          checkout: { ready: false },
          price: { currency: 'INR', amount: 399900, reason: 'bound' },
        });
        expect(plans.find((plan) => plan.slug === 'pro')).toMatchObject({
          checkout: { ready: false },
          price: { currency: 'INR', amount: 149900, reason: 'bound' },
        });
      }
    });

    it('leaves every other buyer on the page they had', async () => {
      const other = await w.newBuyer();
      const plans = await catalogue({ buyer: other });
      expect(plans.find((plan) => plan.slug === 'team')).toMatchObject({
        checkout: { ready: true },
        price: { currency: 'USD', amount: 5000, reason: 'default' },
      });
    });

    it('still refuses their checkout', async () => {
      const res = await w.checkout({ planSlug: 'team' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('BILLING_CURRENCY_CONFLICT');
      expect(res.json().error.message).toContain('"razorpay", the provider they pay through, is no longer set up to charge INR.');
    });
  });

  describe('GET /billing/plans for a signed-in buyer', () => {
    it('costs the same number of queries for seven recurring plans as for two', async () => {
      await subscribeInInr(w.buyer);
      const measure = async (): Promise<number> => {
        await w.asBuyer('GET', '/plans?limit=50');
        const counted = await countQueries(async () => {
          const res = await w.asBuyer('GET', '/plans?limit=50');
          expect(res.statusCode, res.body).toBe(200);
        });
        return counted.count;
      };
      const addPlans = async (from: number, to: number): Promise<void> => {
        for (let i = from; i < to; i += 1) {
          await w.createPlan({ slug: `p${i}`, name: `Plan ${i}`, price: { currency: 'USD', amount: 3000 + i } });
          await w.putPrice(`p${i}`, 'INR', 250000 + i);
        }
      };
      await addPlans(0, 1);
      const two = await measure();
      await addPlans(1, 6);
      const seven = await measure();
      expect(seven).toBe(two);
    });
  });

  describe('a plan out of step with its default price row', () => {
    it('is repaired once by eight reads that meet it together, and none of them fails', async () => {
      const before = await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } });
      // What an older build, or a person with database access, does.
      await prisma.$executeRaw`UPDATE "plans" SET "currency" = 'EUR', "amount" = 1800 WHERE "id" = ${w.planId}`;

      const reads = await Promise.all(
        Array.from({ length: 8 }, () =>
          app.inject({ method: 'GET', url: '/api/v1/billing/plans', headers: { authorization: `Bearer ${w.publishableKey}` } }),
        ),
      );

      expect(reads.map((res) => res.statusCode)).toEqual(Array.from({ length: 8 }, () => 200));
      for (const res of reads) {
        const [plan] = (res.json().data as { items: CataloguePlan[] }).items;
        expect(plan!.price).toMatchObject({ currency: 'EUR', amount: 1800 });
      }
      const after = await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } });
      const live = await prisma.planPrice.findMany({ where: { planId: w.planId, archivedAt: null, currency: { not: 'INR' } } });
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ id: after.defaultPriceId, currency: 'EUR', amount: 1800 });
      expect(await prisma.planPrice.findUnique({ where: { id: before.defaultPriceId! } })).toBeNull();
    });
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

  describe('the billing event outbox poller', () => {
    const queueOne = () =>
      enqueueBillingEvent({
        applicationId: w.applicationId,
        actor: { type: 'system' },
        type: 'settings.local_prices_changed',
        data: { before: 'trusted', after: 'any' },
      });

    it('costs one statement when nothing is due and nothing is old enough to prune', async () => {
      // Whatever earlier tests in this file left queued.
      await drainBillingEventOutbox(1000);
      const idle = await countQueries(async () => {
        expect(await pollBillingEventOutbox()).toBe(0);
      });
      expect(idle.count).toBe(1);
    });

    it('drains a row that is due and leaves one that is not', async () => {
      await drainBillingEventOutbox(1000);
      const due = await queueOne();
      const later = await queueOne();
      await prisma.billingEventOutbox.update({ where: { id: later.outboxId }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });

      expect(await pollBillingEventOutbox()).toBe(1);
      expect((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: due.outboxId } })).processedAt).not.toBeNull();
      expect((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: later.outboxId } })).processedAt).toBeNull();
    });

    it('prunes a row processed long ago even when nothing is due', async () => {
      const { outboxId } = await queueOne();
      await drainBillingEventOutbox(1000);
      await prisma.billingEventOutbox.update({ where: { id: outboxId }, data: { processedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });

      expect(await pollBillingEventOutbox()).toBe(0);
      expect(await prisma.billingEventOutbox.findUnique({ where: { id: outboxId } })).toBeNull();
    });
  });

  describe("a provider's currencies", () => {
    const PAYPAL = { clientId: 'paypal_client_ci', clientSecret: 'paypal_secret_ci', webhookId: 'WH-CI' };
    const stored = async (provider: string) =>
      (await prisma.billingCredentials.findUniqueOrThrow({ where: { applicationId_provider: { applicationId: w.applicationId, provider } } })).currencies;

    it.each([
      ['paypal', 'INR', 'PayPal'],
      ['razorpay', 'ARS', 'Razorpay'],
      ['stripe', 'KWD', 'Stripe'],
      ['stripe', 'BGN', 'Stripe'],
    ])('refuses to save %s with %s, which it cannot charge, naming both', async (provider, code, label) => {
      if (provider === 'paypal') await billingCredentialsService.upsertRaw(w.applicationId, 'paypal', PAYPAL, { mode: 'test', currencies: ['USD'] });
      const before = await stored(provider);

      const patched = await w.operator('PATCH', `/billing-credentials/${provider}`, { enabled: false, currencies: ['usd', code.toLowerCase()] });
      expect(patched.statusCode, patched.body).toBe(400);
      expect(patched.json().error).toMatchObject({ code: 'BILLING_PROVIDER_CURRENCY_NOT_OFFERED' });
      expect(patched.json().error.message).toBe(`${label} ("${provider}") cannot charge ${code}.`);
      expect(patched.json().error.fix).toContain(`Remove ${code} from`);

      const row = await prisma.billingCredentials.findUniqueOrThrow({ where: { applicationId_provider: { applicationId: w.applicationId, provider } } });
      expect(row.currencies).toEqual(before);
      // The refused edit applied nothing else it carried.
      expect(row.enabled).toBe(true);
    });

    it('refuses the same on the route that saves credentials', async () => {
      const res = await w.operator('PUT', '/billing-credentials/paypal', { data: PAYPAL, mode: 'test', currencies: ['USD', 'INR'] });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('BILLING_PROVIDER_CURRENCY_NOT_OFFERED');
      expect(await prisma.billingCredentials.count({ where: { applicationId: w.applicationId, provider: 'paypal' } })).toBe(0);
    });

    it('saves every code a provider publishes', async () => {
      const res = await w.operator('GET', '/billing/providers');
      const providers = (res.json().data as { providers: Array<{ name: string; supportedCurrencies: string[] | 'all-sellable' }> }).providers;
      for (const name of ['stripe', 'razorpay']) {
        const supported = providers.find((p) => p.name === name)!.supportedCurrencies as string[];
        expect(supported.length).toBeGreaterThan(20);
        const saved = await w.operator('PATCH', `/billing-credentials/${name}`, { currencies: supported });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(await stored(name)).toEqual(supported);
      }
    });

    describe('on a row saved before the list was checked', () => {
      beforeEach(async () => {
        await billingCredentialsService.upsertRaw(w.applicationId, 'paypal', PAYPAL, { mode: 'test', currencies: ['USD'], priority: 5 });
        // PayPal holds INR, which it cannot charge, and nothing else charges INR.
        await prisma.billingCredentials.update({
          where: { applicationId_provider: { applicationId: w.applicationId, provider: 'paypal' } },
          data: { currencies: ['INR', 'USD'] },
        });
        await razorpayCharges(['USD']);
      });

      it('shows the operator which codes are unsupported, on both lists', async () => {
        const discovery = await w.operator('GET', '/billing/providers');
        expect(discovery.statusCode, discovery.body).toBe(200);
        const paypal = (discovery.json().data as { providers: Array<{ name: string; status: Record<string, unknown> | null }> }).providers.find((p) => p.name === 'paypal');
        expect(paypal!.status).toMatchObject({ currencies: ['INR', 'USD'], unsupportedCurrencies: ['INR'] });
        const list = await w.operator('GET', '/billing-credentials');
        const rows = list.json().data as Array<{ provider: string; unsupportedCurrencies: string[] }>;
        expect(rows.find((row) => row.provider === 'paypal')!.unsupportedCurrencies).toEqual(['INR']);
        expect(rows.find((row) => row.provider === 'stripe')!.unsupportedCurrencies).toEqual([]);
      });

      it('skips the code at routing: a buyer in India is charged the default price, not sent to PayPal in INR', async () => {
        const { provider, row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
        expect(row.currency).toBe('USD');
        expect(['paypal', 'stripe', 'razorpay']).toContain(provider);
      });

      it('says which provider was skipped when a checkout must be in that currency', async () => {
        const res = await w.checkout({ currency: 'INR', onUnavailableCurrency: 'refuse' });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');

        await w.createPlan({ slug: 'rupees', name: 'Rupees', price: { currency: 'INR', amount: 99900 } });
        const onlyInr = await w.checkout({ planSlug: 'rupees' });
        expect(onlyInr.statusCode, onlyInr.body).toBe(400);
        expect(onlyInr.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');
        expect(onlyInr.json().error.message).toContain('"paypal" lists INR but cannot charge it at all, so it was skipped.');

        const named = await w.checkout({ planSlug: 'rupees', provider: 'paypal' });
        expect(named.statusCode, named.body).toBe(400);
        expect(named.json().error).toMatchObject({ code: 'BILLING_PROVIDER_CURRENCY_UNSUPPORTED' });
        expect(named.json().error.fix).toBe('Omit `provider` to let Rekey pick one that can. "paypal" cannot charge INR at all.');
      });
    });
  });
});
