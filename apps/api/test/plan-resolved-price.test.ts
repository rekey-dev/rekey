/**
 * `price` on a plan is the price checkout would charge this buyer.
 *
 * The catalogue and checkout decide through one function, so for every buyer
 * here the two are asked the same question and must give the same answer. A
 * pricing page that renders `plan.price` then cannot show a price the buyer
 * is not charged.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PlanPriceDto, PublicPlanPriceDto, ResolvedPriceDto } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

interface PublicPlanRow {
  slug: string;
  amount: number;
  currency: string;
  prices: PublicPlanPriceDto[];
  price: ResolvedPriceDto | null;
}

describe('the resolved price on a plan', () => {
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

  interface Caller {
    key?: 'secret' | 'publishable';
    country?: string;
    buyer?: Buyer;
    headers?: Record<string, string>;
  }

  async function catalogue(caller: Caller = {}): Promise<PublicPlanRow[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/plans${caller.country === undefined ? '' : `?country=${caller.country}`}`,
      headers: {
        authorization: `Bearer ${caller.key === 'publishable' ? w.publishableKey : w.secretKey}`,
        ...(caller.buyer !== undefined && { 'x-rekey-user-token': caller.buyer.token }),
        ...caller.headers,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { items: PublicPlanRow[] }).items;
  }

  const priceOf = async (caller: Caller, slug = 'pro') => (await catalogue(caller)).find((plan) => plan.slug === slug)!.price;

  /** What checkout charges the same caller, read off the session it opens. */
  async function charged(caller: Caller, planSlug = 'pro'): Promise<{ currency: string; amount: number; planPriceId: string | null }> {
    const res = await w.checkout(
      { planSlug, ...(caller.country !== undefined && { country: caller.country }) },
      { key: caller.key === 'publishable' ? w.publishableKey : w.secretKey, buyer: caller.buyer ?? (await w.newBuyer()) },
    );
    const { row } = await w.sessionOf(res);
    return { currency: row.currency!, amount: row.unitAmount!, planPriceId: row.planPriceId };
  }

  it('resolves the default price with no buyer, and lists every price with the default first', async () => {
    const [pro] = await catalogue({ key: 'publishable' });
    const { defaultPriceId } = await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } });
    expect(pro!.price).toEqual({
      id: defaultPriceId,
      currency: 'USD',
      amount: 2000,
      formatted: '$20.00',
      isDefault: true,
      reason: 'default',
      requestedCurrency: null,
    });
    expect(pro!.prices).toEqual([
      { id: defaultPriceId, currency: 'USD', amount: 2000, countries: [], isDefault: true, archived: false },
      { id: w.inrPriceId, currency: 'INR', amount: 149900, countries: [], isDefault: false, archived: false },
    ]);
    // The plan carries no amount or currency of its own: `price` is the price.
    expect(pro).not.toHaveProperty('amount');
    expect(pro).not.toHaveProperty('currency');
  });

  it('resolves the local price for a country the operator server declares', async () => {
    expect(await priceOf({ country: 'IN' })).toEqual({
      id: w.inrPriceId,
      currency: 'INR',
      amount: 149900,
      formatted: '₹1,499.00',
      isDefault: false,
      reason: 'country',
      requestedCurrency: null,
    });
    expect(await priceOf({ country: 'US' })).toMatchObject({ currency: 'USD', reason: 'default' });
  });

  it('does not believe a country a browser merely states', async () => {
    expect(await priceOf({ key: 'publishable', country: 'IN' })).toMatchObject({ currency: 'USD', reason: 'default' });
    expect(await priceOf({ key: 'publishable', headers: { 'cf-ipcountry': 'IN' } })).toMatchObject({ currency: 'USD', reason: 'default' });
  });

  it('says fallback when the local price cannot be charged, and charges the default', async () => {
    await billingCredentialsService.upsertRaw(
      w.applicationId,
      'razorpay',
      { keyId: 'rzp_test_ci', keySecret: 'secret_ci_only', webhookSecret: 'whsec_rzp_ci_only' },
      { mode: 'test', enabled: true, currencies: ['AED'], countries: ['IN'], priority: 50 },
    );
    expect(await priceOf({ country: 'IN' })).toMatchObject({ currency: 'USD', amount: 2000, isDefault: true, reason: 'fallback' });
  });

  it('keeps a subscriber in the currency they already pay in, on every plan', async () => {
    await w.createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
    await w.putPrice('team', 'INR', 399900);
    const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
    await w.razorpayWebhook({
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: row.providerSessionId, status: 'active' } } },
    });

    // Now in Germany, where nothing but the default would apply: they still pay in rupees.
    const caller = { country: 'DE', buyer: w.buyer };
    expect(await priceOf(caller, 'team')).toMatchObject({ currency: 'INR', amount: 399900, reason: 'bound' });
    expect(await charged(caller, 'team')).toMatchObject({ currency: 'INR', amount: 399900 });
    // Someone else in Germany gets the default.
    expect(await priceOf({ country: 'DE', buyer: await w.newBuyer() }, 'team')).toMatchObject({ currency: 'USD', reason: 'default' });
  });

  it('refuses a user token that is present and invalid, as every other route does', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: { authorization: `Bearer ${w.publishableKey}`, 'x-rekey-user-token': 'not-a-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
  });

  it('answers what checkout charges, for every kind of caller', async () => {
    const callers: Caller[] = [
      {},
      { country: 'IN' },
      { country: 'in' },
      { country: 'US' },
      { country: 'DE' },
      { key: 'publishable' },
      { key: 'publishable', country: 'IN' },
    ];
    for (const caller of callers) {
      const buyer = await w.newBuyer();
      const shown = await priceOf({ ...caller, buyer });
      const paid = await charged({ ...caller, buyer });
      const label = JSON.stringify(caller);
      expect({ currency: shown!.currency, amount: shown!.amount }, label).toEqual({ currency: paid.currency, amount: paid.amount });
      // One representation end to end: the session names the price row, the default included.
      expect(shown!.id, label).toBe(paid.planPriceId);
    }
  });

  it('gives a plan with no flat price no prices and a null price', async () => {
    await w.createPlan({ slug: 'free', name: 'Free', });
    const free = (await catalogue()).find((plan) => plan.slug === 'free')!;
    expect(free.prices).toEqual([]);
    expect(free.price).toBeNull();
  });

  it('keeps registration detail for the operator and off the public catalogue', async () => {
    const [publicPlan] = await catalogue({ key: 'publishable' });
    for (const price of publicPlan!.prices) expect(price).not.toHaveProperty('registration');

    const listed = await w.operator('GET', '/plans');
    const plan = (listed.json().data as { items: Array<{ prices: PlanPriceDto[]; price: ResolvedPriceDto }> }).items[0]!;
    expect(plan.prices.map((price) => [price.currency, price.isDefault, price.registration])).toEqual([
      ['USD', true, { status: 'REGISTERED', error: null }],
      ['INR', false, { status: 'NOT_REQUIRED', error: null }],
    ]);
    // An operator is no buyer: the price resolved for them is the default.
    expect(plan.price).toMatchObject({ currency: 'USD', amount: 2000, isDefault: true, reason: 'default' });

    const single = await w.operator('PATCH', '/plans/pro', { name: 'Pro plan' });
    expect((single.json().data as { price: ResolvedPriceDto }).price).toMatchObject({ currency: 'USD', reason: 'default' });
  });

  it('follows the plan: a default price edited through the plan is the same row with the new amount', async () => {
    const draft = await w.createPlan({ slug: 'draft', name: 'Draft', price: { currency: 'USD', amount: 1000 } });
    await prisma.plan.update({ where: { id: draft }, data: { metadata: {}, registrationStatus: 'NOT_REQUIRED' } });
    const before = (await prisma.plan.findUniqueOrThrow({ where: { id: draft } })).defaultPriceId;

    const patched = await w.operator('PATCH', '/plans/draft', { price: { currency: 'USD', amount: 1200 } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((patched.json().data as { price: ResolvedPriceDto }).price).toMatchObject({ id: before, amount: 1200, formatted: '$12.00' });
    expect(await prisma.planPrice.findUniqueOrThrow({ where: { id: before! } })).toMatchObject({ amount: 1200, currency: 'USD' });

    // Free now: the plan has no price row and says so.
    const freed = await w.operator('PATCH', '/plans/draft', { price: null });
    expect(freed.statusCode, freed.body).toBe(200);
    expect(freed.json().data).toMatchObject({ price: null, prices: [], isFree: true, defaultPriceId: null });
    expect(await prisma.planPrice.count({ where: { planId: draft } })).toBe(0);
  });

  it('archives a default price a subscriber is on when the plan is re-priced, and keeps their snapshot', async () => {
    const draft = await w.createPlan({ slug: 'draft', name: 'Draft', price: { currency: 'USD', amount: 1000 } });
    await prisma.plan.update({ where: { id: draft }, data: { metadata: {}, registrationStatus: 'NOT_REQUIRED' } });
    const granted = await w.operator('POST', `/end-users/${w.buyer.id}/subscriptions`, { planSlug: 'draft', currency: 'USD' });
    expect(granted.statusCode, granted.body).toBe(201);
    const old = (await prisma.plan.findUniqueOrThrow({ where: { id: draft } })).defaultPriceId!;

    const patched = await w.operator('PATCH', '/plans/draft', { price: { currency: 'USD', amount: 1500 } });
    expect(patched.statusCode, patched.body).toBe(200);

    const now = (await prisma.plan.findUniqueOrThrow({ where: { id: draft } })).defaultPriceId!;
    expect(now).not.toBe(old);
    expect((await prisma.planPrice.findUniqueOrThrow({ where: { id: old } })).archivedAt).not.toBeNull();
    expect(await prisma.planPrice.findUniqueOrThrow({ where: { id: now } })).toMatchObject({ amount: 1500, archivedAt: null });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { endUserId: w.buyer.id, planId: draft } });
    expect(sub).toMatchObject({ planPriceId: old, currency: 'USD', unitAmount: 1000 });
    // The archived price is not listed.
    expect((patched.json().data as { prices: PlanPriceDto[] }).prices.map((price) => price.id)).toEqual([now]);
  });
});
