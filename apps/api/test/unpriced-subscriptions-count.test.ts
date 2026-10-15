/**
 * An operator can tell a subscription with no price of its own from a priced
 * one, and count the live ones that should have a price: what `rekey doctor`
 * reads. Every answer is read off the HTTP response.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

type Row = { status: string; plan: { slug: string }; price: { amount: number; currency: string } | null };

describe('subscriptions with no price of their own, for operators', () => {
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

  const subscriptionsOf = async (endUserId: string): Promise<Row[]> => {
    const res = await w.operator('GET', `/end-users/${endUserId}/billing`);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { subscriptions: Row[] }).subscriptions;
  };
  const unpricedCount = async (): Promise<number> => {
    const res = await w.operator('GET', '/billing/stats');
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { unpricedLiveSubscriptions: number }).unpricedLiveSubscriptions;
  };
  const grant = (endUserId: string, body: Record<string, unknown>) => w.operator('POST', `/end-users/${endUserId}/subscriptions`, body);
  /** A row as an older build or an external activation with no price left it. */
  const bare = async (status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'PENDING' | 'CANCELED', planId = w.planId): Promise<string> => {
    const { id } = await w.newBuyer();
    await prisma.subscription.create({ data: { applicationId: w.applicationId, endUserId: id, planId, status, provider: 'external' } });
    return id;
  };

  it('reports `price: null` for a subscription with no price of its own, and the price for one that has it', async () => {
    const unpriced = await bare('ACTIVE');
    expect(await subscriptionsOf(unpriced)).toMatchObject([{ status: 'ACTIVE', plan: { slug: 'pro' }, price: null }]);

    const granted = (await w.newBuyer()).id;
    expect((await grant(granted, { planSlug: 'pro', currency: 'INR' })).statusCode).toBe(201);
    expect(await subscriptionsOf(granted)).toMatchObject([{ status: 'ACTIVE', price: { amount: 149900, currency: 'INR' } }]);

    await w.createPlan({ slug: 'free', name: 'Free' });
    const onFree = (await w.newBuyer()).id;
    expect((await grant(onFree, { planSlug: 'free' })).statusCode).toBe(201);
    expect(await subscriptionsOf(onFree)).toMatchObject([{ plan: { slug: 'free' }, price: null }]);
  });

  it('counts the live ones on a plan that has a price, and nothing else', async () => {
    expect(await unpricedCount()).toBe(0);

    await bare('ACTIVE');
    await bare('TRIALING');
    await bare('PAST_DUE');
    // Not live, so not counted: a checkout still to be paid, and a subscription that ended.
    await bare('PENDING');
    await bare('CANCELED');
    // Priced, so not counted.
    expect((await grant((await w.newBuyer()).id, { planSlug: 'pro' })).statusCode).toBe(201);
    // On a plan with no flat price, where no price is the right answer.
    const freePlanId = await w.createPlan({ slug: 'free', name: 'Free' });
    await bare('ACTIVE', freePlanId);
    expect((await grant((await w.newBuyer()).id, { planSlug: 'free' })).statusCode).toBe(201);

    expect(await unpricedCount()).toBe(3);
  });

  it('counts only its own Application', async () => {
    await bare('ACTIVE');
    const other = await twoCurrencyWorld(app);
    const res = await other.operator('GET', '/billing/stats');
    expect(res.json().data.unpricedLiveSubscriptions).toBe(0);
    expect(await unpricedCount()).toBe(1);
  });

  it('goes back to zero when the plan is granted again: the subscription takes a price and keeps the rest', async () => {
    const unpriced = await bare('ACTIVE');
    expect(await unpricedCount()).toBe(1);

    const again = await grant(unpriced, { planSlug: 'pro' });
    expect(again.statusCode, again.body).toBe(200);
    expect(await subscriptionsOf(unpriced)).toMatchObject([{ status: 'ACTIVE', price: { amount: 2000, currency: 'USD' } }]);
    expect(await unpricedCount()).toBe(0);
  });
});
