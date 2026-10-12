/**
 * A subscription with no price recorded binds its buyer to a provider and to
 * no currency. Its plan's default price is not read in its place.
 *
 * The world: Stripe charges USD only, Razorpay INR only; `pro` is USD 20.00
 * with an INR 1,499.00 price.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { pricedAt } from './subscription-price-fixture.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

describe('binding of a buyer whose subscription has no price', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function boundThroughRazorpay(price: Record<string, unknown>): Promise<void> {
    const otherId = await w.createPlan({ slug: 'other', name: 'Other', price: { currency: 'USD', amount: 500 }, interval: 'MONTH' });
    await prisma.subscription.create({
      data: {
        applicationId: w.applicationId,
        endUserId: w.buyer.id,
        planId: otherId,
        status: 'ACTIVE',
        provider: 'razorpay',
        providerSubId: 'sub_legacy_1',
        ...(price.currency !== undefined ? await pricedAt(otherId, price.currency as string, 500) : {}),
      },
    });
  }

  it('an unpriced subscription leaves the currency to the country: a buyer in India is charged INR', async () => {
    w = await twoCurrencyWorld(app);
    await boundThroughRazorpay({});
    const res = await w.checkout({ country: 'IN' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.price).toMatchObject({ currency: 'INR', amount: 149900, reason: 'country' });
    const { provider, row } = await w.sessionOf(res);
    expect(provider).toBe('razorpay');
    expect(row.currency).toBe('INR');
  });

  it('a priced subscription still binds its currency: the same buyer on a USD price is refused, not moved', async () => {
    w = await twoCurrencyWorld(app);
    await boundThroughRazorpay({ currency: 'USD' });
    const res = await w.checkout({ country: 'IN' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('BILLING_BOUND_PROVIDER_CURRENCY_UNSUPPORTED');
  });
});
