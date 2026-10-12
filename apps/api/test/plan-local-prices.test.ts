/**
 * A plan's own rule for local prices is set through PATCH .../plans/:slug,
 * decides what a buyer's country selects, and leaves a billing event with the
 * value before and after when it changes. Asserted on the wire.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface LoggedChange {
  type: string;
  actor: { type: string; id: string | null };
  planId: string | null;
  data: { planSlug: string; before: string; after: string };
}

describe('per-plan local prices', () => {
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

  /** The plan's changes as the billing log route returns them, oldest first. */
  async function logged(): Promise<LoggedChange[]> {
    const res = await w.operator('GET', '/billing/events?type=plan.local_prices_changed');
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { items: LoggedChange[] }).items.reverse();
  }

  /** The price a buyer in India is quoted for `pro`, by the function checkout uses. */
  async function quotedInIndia(): Promise<string> {
    const res = await w.asBuyer('GET', '/plans?country=IN');
    expect(res.statusCode, res.body).toBe(200);
    const plan = (res.json().data as { items: Array<{ slug: string; price: { currency: string } }> }).items.find((each) => each.slug === 'pro')!;
    return plan.price.currency;
  }

  it('sets the rule, returns it, and logs the change with the value before and after, by the operator who made it', async () => {
    const operatorId = (await prisma.tenantUser.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).id;
    const res = await w.operator('PATCH', '/plans/pro', { localPrices: 'OFF' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().data as { localPrices: string }).localPrices).toBe('OFF');
    const listed = await w.operator('GET', '/plans');
    expect((listed.json().data as { items: Array<{ localPrices: string }> }).items[0]!.localPrices).toBe('OFF');

    expect(await logged()).toEqual([
      expect.objectContaining({
        type: 'plan.local_prices_changed',
        actor: { type: 'operator', id: operatorId },
        planId: w.planId,
        data: { planSlug: 'pro', before: 'inherit', after: 'off' },
      }),
    ]);

    await w.operator('PATCH', '/plans/pro', { localPrices: 'TRUSTED' });
    expect((await logged()).map((event) => event.data)).toEqual([
      { planSlug: 'pro', before: 'inherit', after: 'off' },
      { planSlug: 'pro', before: 'off', after: 'trusted' },
    ]);
  });

  it('logs nothing when the value sent is the one the plan has, or when another field changes', async () => {
    expect((await w.operator('PATCH', '/plans/pro', { localPrices: 'INHERIT' })).statusCode).toBe(200);
    expect((await w.operator('PATCH', '/plans/pro', { name: 'Pro plan' })).statusCode).toBe(200);
    expect(await logged()).toEqual([]);

    expect((await w.operator('PATCH', '/plans/pro', { name: 'Pro', localPrices: 'OFF' })).statusCode).toBe(200);
    expect((await w.operator('PATCH', '/plans/pro', { localPrices: 'OFF' })).statusCode).toBe(200);
    expect(await logged()).toHaveLength(1);
  });

  it('decides what a buyer in another country is quoted: OFF charges the default price, INHERIT the local one', async () => {
    expect(await quotedInIndia()).toBe('INR');
    await w.operator('PATCH', '/plans/pro', { localPrices: 'OFF' });
    expect(await quotedInIndia()).toBe('USD');
    await w.operator('PATCH', '/plans/pro', { localPrices: 'INHERIT' });
    expect(await quotedInIndia()).toBe('INR');
  });

  it('changes on a plan a provider has registered, where the price cannot', async () => {
    await prisma.plan.update({ where: { id: w.planId }, data: { metadata: { stripe: { priceId: 'price_held' } }, registrationStatus: 'REGISTERED' } });
    const price = await w.operator('PATCH', '/plans/pro', { price: { currency: 'USD', amount: 2500 } });
    expect(price.statusCode).toBe(409);
    const rule = await w.operator('PATCH', '/plans/pro', { localPrices: 'TRUSTED' });
    expect(rule.statusCode, rule.body).toBe(200);
    expect((rule.json().data as { localPrices: string }).localPrices).toBe('TRUSTED');
  });

  it('starts a credit pack as TRUSTED, and logs that as the value before', async () => {
    await w.createPlan({ slug: 'pack', name: 'Pack', kind: 'CREDIT', creditsAmount: 100, price: { currency: 'USD', amount: 1000 } });
    const res = await w.operator('PATCH', '/plans/pack', { localPrices: 'INHERIT' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await logged()).map((event) => event.data)).toEqual([{ planSlug: 'pack', before: 'trusted', after: 'inherit' }]);
  });

  it.each(['inherit', 'ANY', 'on', true, null])('refuses %j and changes nothing', async (value) => {
    const res = await w.operator('PATCH', '/plans/pro', { localPrices: value });
    expect(res.statusCode, res.body).toBe(400);
    // The route's schema refuses it before the handler runs, and names the field.
    expect(res.json().error).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('localPrices') });
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } })).localPrices).toBe('INHERIT');
    expect(await logged()).toEqual([]);
  });

  it('is set on the super-admin route too, logged as the system', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/applications/${w.applicationId}/plans/pro`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { localPrices: 'OFF' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().data as { localPrices: string }).localPrices).toBe('OFF');
    expect(await logged()).toEqual([
      expect.objectContaining({ actor: { type: 'system', id: null }, data: { planSlug: 'pro', before: 'inherit', after: 'off' } }),
    ]);
  });
});
