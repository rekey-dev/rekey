/**
 * Each price on an operator's plan says whether its amount can still change
 * and who is on it, read with two grouped queries for the whole page. What it
 * says agrees with what the routes that change or remove a price answer, and
 * none of it reaches the public catalogue. Asserted on the wire.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PagedSchema, PlanDtoSchema, PublicPlanDtoSchema } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { countQueries } from './query-counter.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

interface WirePrice {
  id: string;
  currency: string;
  amount: number;
  isDefault: boolean;
  amountEditable: boolean;
  liveSubscriptions: number;
  openCheckouts: number;
}

const FACTS = ['amountEditable', 'liveSubscriptions', 'openCheckouts'] as const;

describe('price usage facts on the operator plan', () => {
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

  async function pricesOf(slug = 'pro'): Promise<Record<string, WirePrice>> {
    const res = await w.operator('GET', '/plans');
    expect(res.statusCode, res.body).toBe(200);
    const plan = PagedSchema(PlanDtoSchema).parse(res.json().data).items.find((each) => each.slug === slug)!;
    return Object.fromEntries(plan.prices.map((price) => [price.currency, price]));
  }

  const usage = async (currency: string, slug = 'pro') => {
    const { liveSubscriptions, openCheckouts } = (await pricesOf(slug))[currency]!;
    return { liveSubscriptions, openCheckouts };
  };

  it('counts the open checkouts and the live subscriptions on each price, and stops counting them when they end', async () => {
    expect(await usage('USD')).toEqual({ liveSubscriptions: 0, openCheckouts: 0 });
    expect(await usage('INR')).toEqual({ liveSubscriptions: 0, openCheckouts: 0 });

    // A buyer in India opens a checkout on the INR price.
    const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
    expect(row.planPriceId).toBe(w.inrPriceId);
    expect(await usage('INR')).toEqual({ liveSubscriptions: 0, openCheckouts: 1 });
    expect(await usage('USD')).toEqual({ liveSubscriptions: 0, openCheckouts: 0 });

    // It is paid: the checkout is no longer open and the subscription is live.
    await w.razorpayWebhook({
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: row.providerSessionId, status: 'active' } } },
    });
    expect(await usage('INR')).toEqual({ liveSubscriptions: 1, openCheckouts: 0 });

    // Two more buyers are granted the plan, which puts them on its default price.
    for (const buyer of [await w.newBuyer(), await w.newBuyer()]) {
      const granted = await w.operator('POST', `/end-users/${buyer.id}/subscriptions`, { planSlug: 'pro' });
      expect(granted.statusCode, granted.body).toBe(201);
    }
    expect(await usage('USD')).toEqual({ liveSubscriptions: 2, openCheckouts: 0 });

    // An ended subscription is not live, and a checkout past its expiry is not open.
    await prisma.subscription.updateMany({ where: { planPriceId: w.inrPriceId }, data: { status: 'CANCELED' } });
    expect(await usage('INR')).toEqual({ liveSubscriptions: 0, openCheckouts: 0 });
    const second = await w.sessionOf(await w.checkout({ country: 'IN' }, { buyer: await w.newBuyer() }));
    expect((await usage('INR')).openCheckouts).toBe(1);
    await prisma.checkoutSession.update({ where: { id: second.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await usage('INR')).openCheckouts).toBe(0);
  });

  it('says a price can be removed exactly when the delete route will remove it', async () => {
    const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
    expect((await usage('INR')).openCheckouts).toBe(1);
    const whileOpen = await w.operator('DELETE', '/plans/pro/prices/INR');
    expect(whileOpen.statusCode, whileOpen.body).toBe(409);
    expect(whileOpen.json().error).toMatchObject({ code: 'PLAN_PRICE_IN_USE', message: expect.stringContaining('1 open checkout') });

    await prisma.checkoutSession.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
    expect(await usage('INR')).toEqual({ liveSubscriptions: 0, openCheckouts: 0 });
    expect((await w.operator('DELETE', '/plans/pro/prices/INR')).statusCode).toBe(200);
  });

  const INR_URL = '/plans/pro/prices/INR';
  const inrRow = () => prisma.planPrice.findUniqueOrThrow({ where: { id: w.inrPriceId } });

  /**
   * A checkout open on the INR price with no provider holding the price. A
   * recurring checkout registers its price; a one-time one does not, and this
   * leaves the price as that would.
   */
  async function openUnregisteredInrCheckout(): Promise<{ id: string }> {
    const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
    await prisma.planPrice.update({ where: { id: w.inrPriceId }, data: { metadata: {}, registrationStatus: 'NOT_REQUIRED' } });
    return row;
  }

  it('reports amountEditable as the routes that change an amount will answer, for every state a price can be in', async () => {
    // A second plan no provider has registered: its default price can still be changed.
    await prisma.billingCredentials.deleteMany({ where: { applicationId: w.applicationId, provider: 'stripe' } });
    await w.createPlan({ slug: 'draft', name: 'Draft', price: { currency: 'USD', amount: 900 } });
    for (const [currency, amount] of [['EUR', 800], ['GBP', 700], ['JPY', 1200], ['CAD', 1100]] as const) {
      await w.putPrice('draft', currency, amount);
    }
    const draft = await prisma.plan.findFirstOrThrow({ where: { applicationId: w.applicationId, slug: 'draft' } });
    const set = (currency: string, data: { metadata?: object; registrationStatus?: 'PENDING' | 'FAILED' | 'REGISTERED' }) =>
      prisma.planPrice.updateMany({ where: { planId: draft.id, currency }, data });
    await set('GBP', { metadata: { razorpay: { planId: 'plan_held' } }, registrationStatus: 'REGISTERED' });
    await set('JPY', { registrationStatus: 'PENDING' });
    await set('CAD', { registrationStatus: 'FAILED' });
    // A payment was recorded at the AUD price, and a buyer has a checkout open on the INR one.
    await w.putPrice('draft', 'AUD', 1300);
    const aud = await prisma.planPrice.findFirstOrThrow({ where: { planId: draft.id, currency: 'AUD' } });
    await prisma.payment.create({
      data: { applicationId: w.applicationId, amount: 1300, currency: 'AUD', status: 'SUCCEEDED', planPriceId: aud.id, unitAmount: 1300 },
    });
    await openUnregisteredInrCheckout();
    const refusal: Record<string, string> = { 'pro INR': 'PLAN_PRICE_REFERENCED', 'draft AUD': 'PLAN_PRICE_REFERENCED' };

    const expected: Record<string, boolean> = { 'pro USD': false, 'pro INR': false, 'draft USD': true, 'draft EUR': true, 'draft GBP': false, 'draft JPY': false, 'draft CAD': true, 'draft AUD': false };
    const seen: Record<string, boolean> = {};
    const answered: Record<string, boolean> = {};
    for (const slug of ['pro', 'draft']) {
      for (const price of Object.values(await pricesOf(slug))) {
        const key = `${slug} ${price.currency}`;
        seen[key] = price.amountEditable;
        const amount = price.amount + 100;
        const res = price.isDefault
          ? await w.operator('PATCH', `/plans/${slug}`, { price: { currency: price.currency, amount } })
          : await w.operator('PUT', `/plans/${slug}/prices/${price.currency}`, { amount });
        expect([200, 409], `${key}: ${res.body}`).toContain(res.statusCode);
        if (res.statusCode === 409) expect(res.json().error.code, key).toBe(refusal[key] ?? 'PLAN_PRICE_IMMUTABLE');
        answered[key] = res.statusCode === 200;
      }
    }
    expect(seen).toEqual(expected);
    expect(answered).toEqual(seen);
  });


  it('keeps the amount of an additional price an open checkout is on, and its fix adds the new amount once the checkout is over', async () => {
    const before = await inrRow();
    const row = await openUnregisteredInrCheckout();
    expect((await pricesOf()).INR).toMatchObject({ amountEditable: false, openCheckouts: 1 });

    const refused = await w.operator('PUT', INR_URL, { amount: before.amount + 100 });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'PLAN_PRICE_REFERENCED',
      message: expect.stringContaining('1 open checkout'),
      fix: expect.stringContaining(`DELETE /api/v1/tenant/applications/${w.applicationId}/plans/pro/prices/INR`),
    });
    expect((await inrRow()).amount).toBe(before.amount);

    // What does not change the amount is still accepted.
    expect((await w.operator('PUT', INR_URL, { amount: before.amount })).statusCode).toBe(200);
    expect((await w.operator('PUT', INR_URL, { countries: ['IN', 'NP'] })).statusCode).toBe(200);

    // The fix, followed as written: wait for the checkout, DELETE, then PUT.
    await prisma.checkoutSession.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await w.operator('DELETE', INR_URL)).statusCode).toBe(200);
    const added = await w.operator('PUT', INR_URL, { amount: before.amount + 100 });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().data).toMatchObject({ currency: 'INR', amount: before.amount + 100, amountEditable: true });
  });

  it('keeps the amount of an additional price a subscription is on or was on, and its fix archives the price and adds the new amount', async () => {
    const before = await inrRow();
    const granted = await w.operator('POST', `/end-users/${w.buyer.id}/subscriptions`, { planSlug: 'pro', currency: 'INR' });
    expect(granted.statusCode, granted.body).toBe(201);
    expect((await pricesOf()).INR).toMatchObject({ amountEditable: false, liveSubscriptions: 1 });
    const whileLive = await w.operator('PUT', INR_URL, { amount: before.amount + 100 });
    expect(whileLive.statusCode, whileLive.body).toBe(409);
    expect(whileLive.json().error).toMatchObject({ code: 'PLAN_PRICE_REFERENCED', message: expect.stringContaining('1 live subscription') });

    // The subscription ends. Nobody is on the price, and the record of it still names it.
    await prisma.subscription.updateMany({ where: { planPriceId: w.inrPriceId }, data: { status: 'CANCELED' } });
    expect((await pricesOf()).INR).toMatchObject({ amountEditable: false, liveSubscriptions: 0, openCheckouts: 0 });
    const onRecord = await w.operator('PUT', INR_URL, { amount: before.amount + 100 });
    expect(onRecord.statusCode, onRecord.body).toBe(409);
    expect(onRecord.json().error).toMatchObject({ code: 'PLAN_PRICE_REFERENCED', message: expect.stringContaining('an ended subscription, a payment or a credit grant') });
    expect(onRecord.json().error.fix).not.toContain('Wait until');

    // The fix, followed as written: DELETE archives it, PUT adds the new amount.
    expect((await w.operator('DELETE', INR_URL)).statusCode).toBe(200);
    const added = await w.operator('PUT', INR_URL, { amount: before.amount + 100 });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().data.id).not.toBe(w.inrPriceId);
    const archived = await inrRow();
    expect(archived.amount).toBe(before.amount);
    expect(archived.archivedAt).not.toBeNull();
    expect((await prisma.subscription.findFirstOrThrow({ where: { planPriceId: w.inrPriceId } })).unitAmount).toBe(before.amount);
  });

  it('keeps the amount of an additional price a payment was recorded at', async () => {
    const before = await inrRow();
    await prisma.payment.create({
      data: { applicationId: w.applicationId, amount: before.amount, currency: 'INR', status: 'SUCCEEDED', planPriceId: w.inrPriceId, unitAmount: before.amount },
    });
    expect((await pricesOf()).INR).toMatchObject({ amountEditable: false, liveSubscriptions: 0, openCheckouts: 0 });
    const refused = await w.operator('PUT', INR_URL, { amount: before.amount + 100 });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('PLAN_PRICE_REFERENCED');
    expect((await inrRow()).amount).toBe(before.amount);
  });

  describe('a default price no provider holds, changed through the plan', () => {
    let draftId: string;
    let oldPriceId: string;
    beforeEach(async () => {
      await prisma.billingCredentials.deleteMany({ where: { applicationId: w.applicationId, provider: 'stripe' } });
      draftId = await w.createPlan({ slug: 'draft', name: 'Draft', price: { currency: 'USD', amount: 900 } });
      oldPriceId = (await prisma.plan.findUniqueOrThrow({ where: { id: draftId } })).defaultPriceId!;
    });

    const reprice = async (): Promise<string> => {
      expect((await pricesOf('draft')).USD!.amountEditable).toBe(true);
      const res = await w.operator('PATCH', '/plans/draft', { price: { currency: 'USD', amount: 1200 } });
      expect(res.statusCode, res.body).toBe(200);
      const now = (await pricesOf('draft')).USD!;
      expect(now).toMatchObject({ amount: 1200, isDefault: true });
      return now.id;
    };

    it('is re-priced in place while nothing names it', async () => {
      expect(await reprice()).toBe(oldPriceId);
    });

    it('is archived at its amount and replaced when a subscription names it', async () => {
      const granted = await w.operator('POST', `/end-users/${w.buyer.id}/subscriptions`, { planSlug: 'draft' });
      expect(granted.statusCode, granted.body).toBe(201);
      expect(await reprice()).not.toBe(oldPriceId);
      expect(await prisma.planPrice.findUniqueOrThrow({ where: { id: oldPriceId } })).toMatchObject({ amount: 900, archivedAt: expect.any(Date) });
    });

    it('is archived at its amount and replaced when an open checkout names it', async () => {
      const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
      await prisma.checkoutSession.update({ where: { id: row.id }, data: { planPriceId: oldPriceId, currency: 'USD', unitAmount: 900, chargeAmount: 900 } });
      expect(await reprice()).not.toBe(oldPriceId);
      expect(await prisma.planPrice.findUniqueOrThrow({ where: { id: oldPriceId } })).toMatchObject({ amount: 900, archivedAt: expect.any(Date) });
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.id } })).planPriceId).toBe(oldPriceId);
    });
  });

  it('returns the same facts on the price a PUT answers with', async () => {
    const res = await w.operator('PUT', '/plans/pro/prices/EUR', { amount: 1800 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ currency: 'EUR', amountEditable: true, liveSubscriptions: 0, openCheckouts: 0 });
  });

  it('reads them with one grouped query each, however many plans and prices the page holds', async () => {
    const one = await countQueries(() => w.operator('GET', '/plans'));
    for (const slug of ['team', 'scale', 'max']) {
      await w.createPlan({ slug, name: slug, price: { currency: 'USD', amount: 5000 } });
      await w.putPrice(slug, 'INR', 399900);
      await w.putPrice(slug, 'EUR', 4500);
    }
    await w.sessionOf(await w.checkout({ country: 'IN' }));
    const granted = await w.operator('POST', `/end-users/${w.buyer.id}/subscriptions`, { planSlug: 'team' });
    expect(granted.statusCode, granted.body).toBe(201);

    const many = await countQueries(async () => {
      const res = await w.operator('GET', '/plans');
      expect((res.json().data as { items: unknown[] }).items).toHaveLength(4);
    });
    expect(many.count, many.queries.join('\n')).toBe(one.count);
    const grouped = (table: string) => many.queries.filter((query) => /GROUP BY/i.test(query) && query.includes(`"${table}"`));
    expect(grouped('subscriptions')).toHaveLength(1);
    expect(grouped('checkout_sessions')).toHaveLength(1);
  });

  it('keeps them off the public catalogue, for a publishable key and for a secret key', async () => {
    await w.sessionOf(await w.checkout({ country: 'IN' }));
    for (const key of [w.publishableKey, w.secretKey]) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/billing/plans', headers: { authorization: `Bearer ${key}` } });
      expect(res.statusCode, res.body).toBe(200);
      const { items } = res.json().data as { items: Array<{ slug: string; prices: Array<Record<string, unknown>> }> };
      const prices = items.find((plan) => plan.slug === 'pro')!.prices;
      expect(prices).toHaveLength(2);
      for (const price of prices) {
        expect(Object.keys(price).sort()).toEqual(['amount', 'archived', 'countries', 'currency', 'id', 'isDefault']);
        for (const fact of FACTS) expect(price, fact).not.toHaveProperty(fact);
      }
      expect(PagedSchema(PublicPlanDtoSchema).safeParse(res.json().data).success).toBe(true);
    }
  });
});
