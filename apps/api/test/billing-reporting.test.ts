/**
 * The reporting currency (read, set, logged), the billing stats it leads, and
 * the routing preview.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  BillingStatsDtoSchema,
  RoutingPreviewDtoSchema,
  type BillingStatsDto,
  type RoutingPreviewDto,
} from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { pricedAt } from './subscription-price-fixture.js';
import { billingStatsService } from '../src/modules/billing/stats.service.js';
import * as checkoutPreview from '../src/modules/billing/checkout-preview.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { countQueries } from './query-counter.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

describe('reporting currency', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (w: OperatorWorld, method: 'GET' | 'PUT', token: string, payload?: Record<string, unknown>) =>
    w.inject({
      method,
      url: `/api/v1/tenant/applications/${w.appId}/billing/reporting-currency`,
      headers: bearer(token),
      ...(payload !== undefined && { payload }),
    });
  const changes = (applicationId: string) =>
    prisma.billingEvent.findMany({
      where: { applicationId, type: 'settings.reporting_currency_changed' },
      orderBy: { seq: 'asc' },
    });

  it('reads USD until it is set, stores what is set in upper case, and logs before and after once', async () => {
    const w = await operatorWorld(app);
    expect((await call(w, 'GET', w.ownerToken)).json().data).toEqual({ reportingCurrency: 'USD', name: 'US Dollar' });

    const set = await call(w, 'PUT', w.ownerToken, { reportingCurrency: 'inr' });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().data).toEqual({ reportingCurrency: 'INR', name: 'Indian Rupee' });
    expect((await call(w, 'GET', w.ownerToken)).json().data.reportingCurrency).toBe('INR');

    // The same value again is not a change.
    expect((await call(w, 'PUT', w.ownerToken, { reportingCurrency: 'INR' })).statusCode).toBe(200);

    const events = await changes(w.appId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tier: 'PERMANENT', actorType: 'OPERATOR', data: { before: 'USD', after: 'INR' } });
    expect(events[0]!.actorId).not.toBeNull();

    // Only the one key was written: the rest of the configuration is as it was.
    const row = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    expect(row.billingConfig).toMatchObject({ reportingCurrency: 'INR' });
    const patched = await w.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${w.appId}/billing-config`,
      headers: bearer(w.ownerToken),
      payload: { dunningEnabled: true },
    });
    expect(patched.json().data.billingConfig).toMatchObject({ reportingCurrency: 'INR', dunningEnabled: true });
  });

  it('refuses a code that is not a currency a plan can be priced in, and changes nothing', async () => {
    const w = await operatorWorld(app);
    for (const [code, why] of [
      ['ABC', 'not an ISO 4217'],
      ['XAU', 'not a currency a price can be in'],
      ['KWD', 'three decimal'],
    ] as const) {
      const res = await call(w, 'PUT', w.ownerToken, { reportingCurrency: code });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('BILLING_REPORTING_CURRENCY_INVALID');
      expect(res.json().error.message).toContain(why);
    }
    for (const body of [{}, { reportingCurrency: 'US' }, { reportingCurrency: 'USD', convert: true }, { currency: 'USD' }]) {
      const res = await call(w, 'PUT', w.ownerToken, body);
      expect(res.statusCode, res.body).toBe(400);
    }
    expect(await changes(w.appId)).toEqual([]);
    expect((await call(w, 'GET', w.ownerToken)).json().data.reportingCurrency).toBe('USD');
  });

  it('lets a viewer read it and only an application admin set it, and never another workspace', async () => {
    const w = await operatorWorld(app, 'APP_VIEWER');
    expect((await call(w, 'GET', w.memberToken)).statusCode).toBe(200);
    expect((await call(w, 'PUT', w.memberToken, { reportingCurrency: 'EUR' })).statusCode).toBe(403);
    await w.grant('APP_BILLING');
    expect((await call(w, 'PUT', w.memberToken, { reportingCurrency: 'EUR' })).statusCode).toBe(403);
    await w.grant('APP_ADMIN');
    expect((await call(w, 'PUT', w.memberToken, { reportingCurrency: 'EUR' })).statusCode).toBe(200);
    await w.setScopes(['billing:read']);
    expect((await call(w, 'PUT', w.memberToken, { reportingCurrency: 'GBP' })).statusCode).toBe(403);
    expect((await call(w, 'GET', w.memberToken)).json().data.reportingCurrency).toBe('EUR');

    const stranger = await operatorWorld(app);
    for (const method of ['GET', 'PUT'] as const) {
      const res = await stranger.inject({
        method,
        url: `/api/v1/tenant/applications/${w.appId}/billing/reporting-currency`,
        headers: bearer(stranger.ownerToken),
        ...(method === 'PUT' && { payload: { reportingCurrency: 'JPY' } }),
      });
      expect(res.statusCode, res.body).toBe(404);
    }
    expect((await changes(w.appId)).map((e) => (e.data as { after: string }).after)).toEqual(['EUR']);
  });

  it('keeps every change in order when eight operators set it at once', async () => {
    const w = await operatorWorld(app);
    const codes = ['EUR', 'GBP', 'INR', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF'];
    const results = await Promise.all(codes.map((code) => call(w, 'PUT', w.ownerToken, { reportingCurrency: code })));
    expect(results.map((r) => r.statusCode)).toEqual(codes.map(() => 200));

    const events = (await changes(w.appId)).map((e) => e.data as { before: string; after: string });
    expect(events).toHaveLength(8);
    expect(events[0]!.before).toBe('USD');
    // Each change starts where the one before it ended: no update was lost.
    for (let i = 1; i < events.length; i += 1) expect(events[i]!.before).toBe(events[i - 1]!.after);
    expect(new Set(events.map((e) => e.after))).toEqual(new Set(codes));
    expect((await call(w, 'GET', w.ownerToken)).json().data.reportingCurrency).toBe(events[7]!.after);
  });
});

describe('billing stats per currency', () => {
  let app: FastifyInstance;
  let serial = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function subscribers(applicationId: string, plan: { currency: string; amount: number; interval?: 'MONTH' | 'YEAR' }, n: number, own?: { currency: string; unitAmount: number }) {
    const created = await prisma.plan.create({
      data: { applicationId, slug: `p-${++serial}`, name: 'P', amount: plan.amount, currency: plan.currency, interval: plan.interval ?? 'MONTH', kind: 'SUBSCRIPTION' },
    });
    for (let i = 0; i < n; i += 1) {
      const endUser = await prisma.endUser.create({ data: { applicationId, email: `b-${++serial}@example.com` } });
      // Its own price when it has one, and the plan's otherwise: MRR reads the subscription's.
      const price = await pricedAt(created.id, own?.currency ?? plan.currency, own?.unitAmount ?? plan.amount);
      await prisma.subscription.create({
        data: { applicationId, endUserId: endUser.id, planId: created.id, status: 'ACTIVE', ...price },
      });
    }
  }
  const pay = (applicationId: string, over: Record<string, unknown>) =>
    prisma.payment.create({ data: { applicationId, amount: 1000, currency: 'USD', status: 'SUCCEEDED', ...over } });

  it('lists MRR and revenue per currency with the reporting currency first, and adds nothing across currencies', async () => {
    const w = await operatorWorld(app);
    const id = w.appId;
    await subscribers(id, { currency: 'USD', amount: 2000 }, 2);
    await subscribers(id, { currency: 'USD', amount: 12000, interval: 'YEAR' }, 1);
    // An INR subscriber on a USD plan counts at their own price, in INR.
    await subscribers(id, { currency: 'USD', amount: 2000 }, 1, { currency: 'INR', unitAmount: 149900 });
    await subscribers(id, { currency: 'EUR', amount: 900 }, 3);

    await pay(id, { amount: 2000, currency: 'USD' });
    await pay(id, { amount: 2000, currency: 'usd', status: 'PARTIALLY_REFUNDED', refundedAmount: 500 });
    await pay(id, { amount: 3000, currency: 'USD', status: 'REFUNDED', refundedAmount: 0 });
    await pay(id, { amount: 149900, currency: 'INR' });
    await pay(id, { amount: 700, currency: 'EUR', status: 'FAILED' });
    await pay(id, { amount: 900, currency: 'EUR', status: 'PENDING' });

    const res = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${id}/billing/stats`, headers: bearer(w.ownerToken) });
    expect(res.statusCode, res.body).toBe(200);
    const stats: BillingStatsDto = BillingStatsDtoSchema.strict().parse(res.json().data);

    expect(stats.reportingCurrency).toBe('USD');
    expect(stats.mrr).toEqual([
      { currency: 'USD', mrrCents: 5000, activeSubscriptions: 3 },
      { currency: 'EUR', mrrCents: 2700, activeSubscriptions: 3 },
      { currency: 'INR', mrrCents: 149900, activeSubscriptions: 1 },
    ]);
    expect(stats.revenueLast30d).toEqual([
      // A fully refunded payment is charged and given back in full, whatever its refunded column says.
      { currency: 'USD', grossCents: 7000, refundedCents: 3500, netCents: 3500, payments: 3 },
      { currency: 'INR', grossCents: 149900, refundedCents: 0, netCents: 149900, payments: 1 },
    ]);
    expect(stats.paymentsLast30d).toEqual({ succeeded: 3, failed: 1 });
    expect(stats.monthlyRevenue.map((s) => [s.currency, s.months.length, s.months[11]!.amountCents])).toEqual([
      ['USD', 12, 3500],
      ['INR', 12, 149900],
    ]);
    // The removed scalars are gone, not zeroed.
    for (const removed of ['mrrCents', 'mrrCurrency', 'mixedCurrencies', 'revenueLast30dCents', 'revenueCurrency', 'revenueCurrencies', 'revenueLast30dByCurrency']) {
      expect(res.json().data).not.toHaveProperty(removed);
    }
    // No figure anywhere is the sum of two currencies.
    const crossSums = [5000 + 2700, 5000 + 149900, 2700 + 149900, 5000 + 2700 + 149900, 3500 + 149900, 7000 + 149900];
    const figures: number[] = [];
    JSON.stringify(res.json().data, (_key, value: unknown) => {
      if (typeof value === 'number') figures.push(value);
      return value;
    });
    for (const sum of crossSums) expect(figures).not.toContain(sum);
  });

  it('leads with the reporting currency the operator set, at zero when nothing is in it', async () => {
    const w = await operatorWorld(app);
    const id = w.appId;
    await subscribers(id, { currency: 'USD', amount: 2000 }, 1);
    await pay(id, { amount: 2000, currency: 'USD' });
    const set = await w.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${id}/billing/reporting-currency`,
      headers: bearer(w.ownerToken),
      payload: { reportingCurrency: 'GBP' },
    });
    expect(set.statusCode, set.body).toBe(200);

    const stats = await billingStatsService.forApplication(id);
    expect(stats.reportingCurrency).toBe('GBP');
    expect(stats.mrr).toEqual([
      { currency: 'GBP', mrrCents: 0, activeSubscriptions: 0 },
      { currency: 'USD', mrrCents: 2000, activeSubscriptions: 1 },
    ]);
    expect(stats.revenueLast30d.map((r) => [r.currency, r.netCents])).toEqual([
      ['GBP', 0],
      ['USD', 2000],
    ]);
    expect(stats.monthlyRevenue.map((s) => s.currency)).toEqual(['GBP', 'USD']);
    // Setting it converted nothing: the dollars are still dollars.
    expect((await prisma.payment.findFirstOrThrow({ where: { applicationId: id } })).currency).toBe('USD');
  });

  it('costs the same number of queries with one payment as with hundreds in four currencies', async () => {
    const w = await operatorWorld(app);
    const id = w.appId;
    await pay(id, {});
    const small = await countQueries(() => billingStatsService.forApplication(id));
    await prisma.payment.createMany({
      data: Array.from({ length: 400 }, (_, i) => ({ applicationId: id, amount: 100 + i, currency: ['USD', 'EUR', 'INR', 'JPY'][i % 4]!, status: 'SUCCEEDED' as const })),
    });
    await subscribers(id, { currency: 'EUR', amount: 900 }, 5);
    // The first read after a plan is written outside the API repairs its price row. That is not the stats' own cost.
    await billingStatsService.forApplication(id);
    const large = await countQueries(() => billingStatsService.forApplication(id));
    expect(large.count, large.queries.join('\n')).toBe(small.count);
  });
});

describe('routing preview', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function preview(body: Record<string, unknown>): Promise<RoutingPreviewDto> {
    const res = await w.operator('POST', '/billing/checkout/preview', body);
    expect(res.statusCode, res.body).toBe(200);
    return RoutingPreviewDtoSchema.strict().parse(res.json().data);
  }

  it('says which price and provider a buyer in a country gets, and why', async () => {
    w = await twoCurrencyWorld(app);
    const india = await preview({ country: 'in', plan: 'pro' });
    expect(india).toMatchObject({ country: 'IN', countrySource: 'vouched', localPrices: 'trusted' });
    expect(india.items).toHaveLength(1);
    expect(india.items[0]).toMatchObject({
      plan: { slug: 'pro', name: 'Pro' },
      price: { currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'country' },
      priceFallback: null,
      provider: 'razorpay',
      providerReason: 'country',
      refusal: null,
    });
    expect(india.items[0]!.summary).toBe(
      'A buyer in IN buying Pro pays ₹1,499.00, because Pro is priced in INR for that country, and pays through razorpay, because razorpay is set for buyers in IN.',
    );

    const usa = await preview({ country: 'US', plan: w.planId });
    expect(usa.items[0]).toMatchObject({
      price: { currency: 'USD', amount: 2000, isDefault: true, reason: 'default' },
      provider: 'stripe',
      providerReason: 'only_capable',
      refusal: null,
    });
  });

  it('answers what the checkout itself then does', async () => {
    w = await twoCurrencyWorld(app);
    for (const country of ['IN', 'US', 'DE']) {
      const [item] = (await preview({ country, plan: 'pro', countrySource: 'declared' })).items;
      const { row } = await w.sessionOf(await w.checkout({ country }, { buyer: await w.newBuyer() }));
      expect([country, item!.price?.currency, item!.price?.amount, item!.provider]).toEqual([
        country,
        row.currency,
        row.unitAmount,
        row.provider,
      ]);
    }
  });

  it('shows the fallback to the default price when the local currency cannot be charged', async () => {
    w = await twoCurrencyWorld(app);
    await billingCredentialsService.upsertRaw(
      w.applicationId,
      'razorpay',
      { keyId: 'rzp_test_ci', keySecret: 'secret_ci_only', webhookSecret: 'whsec' },
      { mode: 'test', enabled: false, currencies: ['INR'], countries: ['IN'], priority: 50 },
    );
    const [item] = (await preview({ country: 'IN', plan: 'pro' })).items;
    expect(item).toMatchObject({
      price: { currency: 'USD', amount: 2000, isDefault: true, reason: 'fallback' },
      priceFallback: {
        requested: { currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
        charged: { currency: 'USD', amount: 2000, formatted: '$20.00' },
        reason: 'no_provider_for_currency',
      },
      provider: 'stripe',
      refusal: null,
    });
    expect(item!.summary).toContain('₹1,499.00 was selected first and cannot be charged');
  });

  it('reports the refusal checkout would answer with, instead of failing', async () => {
    w = await twoCurrencyWorld(app);
    const [refuse] = (await preview({ country: 'IN', plan: 'pro', countrySource: 'declared', currency: 'EUR' })).items;
    expect(refuse!.refusal).not.toBeNull();
    expect(refuse).toMatchObject({ price: null, provider: null, providerReason: null });
    expect(refuse!.refusal!.code).toMatch(/^BILLING_/);
    expect(refuse!.summary).toContain('is refused');
  });

  it('does not offer a local price on a hint while local prices are trusted-only', async () => {
    w = await twoCurrencyWorld(app);
    const [hinted] = (await preview({ country: 'IN', plan: 'pro', countrySource: 'hint' })).items;
    expect(hinted!.price).toMatchObject({ currency: 'USD', reason: 'default' });
  });

  it('previews every active plan when none is named, in a number of queries that does not grow with the plans', async () => {
    w = await twoCurrencyWorld(app);
    const one = await countQueries(() => w.operator('POST', '/billing/checkout/preview', { country: 'IN' }));
    for (let i = 0; i < 6; i += 1) {
      await w.createPlan({ slug: `extra-${i}`, name: `Extra ${i}`, price: { currency: 'USD', amount: 500 + i } });
      await w.putPrice(`extra-${i}`, 'INR', 40000 + i);
    }
    let body: RoutingPreviewDto | undefined;
    const many = await countQueries(async () => {
      body = await preview({ country: 'IN' });
    });
    expect(body!.items).toHaveLength(7);
    expect(body!.items.every((item) => item.price?.currency === 'INR' && item.provider === 'razorpay')).toBe(true);
    expect(many.count, many.queries.join('\n')).toBe(one.count);
  });

  it("decides through checkout's own preview functions, opens nothing and writes nothing", async () => {
    w = await twoCurrencyWorld(app);
    const price = vi.spyOn(checkoutPreview, 'previewCheckoutPrice');
    const provider = vi.spyOn(checkoutPreview, 'previewCheckoutProvider');
    const before = {
      sessions: await prisma.checkoutSession.count(),
      subscriptions: await prisma.subscription.count(),
      events: await prisma.billingEvent.count(),
    };
    await preview({ country: 'IN', plan: 'pro' });
    expect(price).toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    price.mockRestore();
    provider.mockRestore();
    expect({
      sessions: await prisma.checkoutSession.count(),
      subscriptions: await prisma.subscription.count(),
      events: await prisma.billingEvent.count(),
    }).toEqual(before);
  });

  it('is read access on the Application, refuses an unknown plan and an unknown key, and is closed to other workspaces', async () => {
    w = await twoCurrencyWorld(app);
    expect((await w.operator('POST', '/billing/checkout/preview', { country: 'IN', plan: 'nope' })).statusCode).toBe(404);
    expect((await w.operator('POST', '/billing/checkout/preview', { country: 'India' })).statusCode).toBe(400);
    expect((await w.operator('POST', '/billing/checkout/preview', { country: 'IN', coupon: 'X' })).statusCode).toBe(400);
    const stranger = await operatorWorld(app);
    const res = await stranger.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.applicationId}/billing/checkout/preview`,
      headers: bearer(stranger.ownerToken),
      payload: { country: 'IN' },
    });
    expect(res.statusCode, res.body).toBe(404);

    // Grants and the billing:read scope decide, not workspace membership alone.
    const member = await operatorWorld(app, 'APP_VIEWER');
    const asMember = (appId: string) =>
      member.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/billing/checkout/preview`,
        headers: bearer(member.memberToken),
        payload: { country: 'IN' },
      });
    expect((await asMember(member.appId)).statusCode).toBe(200);
    const ungranted = await member.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: bearer(member.ownerToken),
      payload: { name: 'Ungranted', slug: `ungranted-${Date.now()}` },
    });
    expect((await asMember((ungranted.json().data as { id: string }).id)).statusCode).toBe(404);
    await member.setScopes(['overview:read']);
    expect((await asMember(member.appId)).statusCode).toBe(403);
  });
});
