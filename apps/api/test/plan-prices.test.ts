/**
 * A plan priced in more than one currency: the operator routes that manage
 * the additional prices, and a checkout charged at one.
 *
 * Stripe is configured to charge USD only and Razorpay INR only, so which
 * provider a checkout reaches says which currency it was routed on.
 */

import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { CheckoutResultDtoSchema, PagedSchema, PublicPlanDtoSchema } from '@rekey.dev/shared-types';
import { fakeRazorpay } from './fakes/billing-providers.js';

const PASSWORD = 'pw-one-two-three';
const RETURN = 'https://app.example/account';
const RZP_WEBHOOK_SECRET = 'rzp_whsec_plan_prices';

describe('plan prices', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let slug: string;
  let operatorAccess: string;
  let secretKey: string;
  let publishableKey: string;
  let userAccess: string;
  let planId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function operator(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url: `/api/v1/tenant/applications/${applicationId}${url}`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      ...(payload !== undefined && { payload }),
    });
  }

  async function createPlan(body: Record<string, unknown>): Promise<string> {
    const res = await operator('POST', '/plans', body);
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { id: string }).id;
  }

  function putPrice(currency: string, body: Record<string, unknown>, plan = planId) {
    return operator('PUT', `/plans/${plan}/prices/${currency}`, body);
  }

  async function newBuyer(): Promise<string> {
    const email = `eu-${Math.random().toString(36).slice(2, 10)}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { email, password: PASSWORD },
    });
    return (res.json().data as { accessToken: string }).accessToken;
  }

  function checkout(extra: Record<string, unknown> = {}, opts: { key?: string; user?: string } = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${opts.key ?? secretKey}`, 'x-rekey-user-token': opts.user ?? userAccess },
      payload: { planSlug: 'pro', successUrl: `${RETURN}?paid=1`, cancelUrl: RETURN, ...extra },
    });
  }

  const defaultPriceId = async (planSlug = 'pro'): Promise<string> =>
    (await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: planSlug } })).defaultPriceId!;
  const fallbackEvents = () =>
    prisma.billingEvent.findMany({ where: { applicationId, type: 'checkout.price_fallback' }, orderBy: { seq: 'asc' } });

  async function sessionOf(res: Awaited<ReturnType<typeof checkout>>) {
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { checkoutSessionId: string; provider: string };
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
    return { provider: data.provider, row };
  }

  beforeEach(async () => {
    slug = `pp-${Math.random().toString(36).slice(2, 8)}`;
    operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await operator('POST', '/api-keys', { name: 'k', mode: 'live' }).then(
      (r) => (r.json().data as { rawKey: string }).rawKey,
    );
    publishableKey = (await prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).publicKey;

    await billingCredentialsService.upsertRaw(
      applicationId,
      'stripe',
      { apiKey: 'sk_test_ci_only', webhookSecret: 'whsec_ci_only' },
      { mode: 'test', enabled: true, currencies: ['USD'], priority: 1 },
    );
    await billingCredentialsService.upsertRaw(
      applicationId,
      'razorpay',
      { keyId: 'rzp_test_ci', keySecret: 'secret_ci_only', webhookSecret: RZP_WEBHOOK_SECRET },
      { mode: 'test', enabled: true, currencies: ['INR'], countries: ['IN'], priority: 50 },
    );
    planId = await createPlan({ slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 2000 } });
    userAccess = await newBuyer();
  });

  describe('PUT and DELETE /plans/:planId/prices/:currency', () => {
    it('creates a price, upper-cases it, and returns it on every plan read', async () => {
      const res = await putPrice('inr', { amount: 149900 });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({
        id: expect.any(String),
        currency: 'INR',
        amount: 149900,
        countries: [],
        isDefault: false,
        archived: false,
        registration: { status: 'NOT_REQUIRED', error: null },
        amountEditable: true,
        liveSubscriptions: 0,
        openCheckouts: 0,
      });
      await putPrice('EUR', { amount: 1800, countries: ['de', 'FR', 'de'] });

      // The default price first, then the others by currency.
      const prices = [
        expect.objectContaining({ currency: 'USD', amount: 2000, countries: [], isDefault: true }),
        expect.objectContaining({ currency: 'EUR', amount: 1800, countries: ['DE', 'FR'], isDefault: false }),
        expect.objectContaining({ currency: 'INR', amount: 149900, countries: [], isDefault: false }),
      ];
      const listed = await operator('GET', '/plans');
      expect((listed.json().data as { items: Array<{ prices: unknown }> }).items[0]!.prices).toEqual(prices);
      const publicList = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/plans',
        headers: { authorization: `Bearer ${publishableKey}` },
      });
      const publicPlan = (publicList.json().data as { items: Array<{ price: unknown; prices: unknown }> }).items[0]!;
      expect(publicPlan).toMatchObject({ price: { amount: 2000, currency: 'USD' }, prices });
      const patched = await operator('PATCH', '/plans/pro', { name: 'Pro plan' });
      expect((patched.json().data as { prices: unknown }).prices).toEqual(prices);
    });

    it('returns only the default price for a plan sold in one currency', async () => {
      const listed = await operator('GET', '/plans');
      expect((listed.json().data as { items: Array<{ prices: unknown }> }).items[0]!.prices).toEqual([
        expect.objectContaining({ currency: 'USD', amount: 2000, isDefault: true, archived: false }),
      ]);
    });

    it('takes the plan by slug as well as by id, and 404s on neither', async () => {
      expect((await putPrice('INR', { amount: 149900 }, 'pro')).statusCode).toBe(200);
      const missing = await putPrice('INR', { amount: 149900 }, 'nope');
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('PLAN_NOT_FOUND');
    });

    it('updates the amount and the countries of a price no provider has registered', async () => {
      await putPrice('INR', { amount: 149900, countries: ['IN'] });
      const repriced = await putPrice('INR', { amount: 99900 });
      expect(repriced.json().data).toMatchObject({ currency: 'INR', amount: 99900, countries: ['IN'] });
      const widened = await putPrice('INR', { amount: 99900, countries: [] });
      expect(widened.json().data).toMatchObject({ currency: 'INR', amount: 99900, countries: [] });
    });

    it("refuses the plan's own currency", async () => {
      const res = await putPrice('usd', { amount: 1900 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'PLAN_PRICE_IS_DEFAULT' });
      expect(res.json().error.fix).toContain('PATCH');
      expect(await prisma.planPrice.count({ where: { currency: { not: 'USD' } } })).toBe(0);
    });

    it('refuses a free plan', async () => {
      const free = await createPlan({ slug: 'free', name: 'Free', });
      const res = await putPrice('INR', { amount: 100 }, free);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('PLAN_PRICE_NOT_APPLICABLE');
      expect(await prisma.planPrice.count({ where: { currency: { not: 'USD' } } })).toBe(0);
    });

    it('refuses an invalid currency, a three-decimal one, a bad amount and a bad country', async () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['XYZ', { amount: 100 }, 'PLAN_PRICE_CURRENCY_INVALID'],
        ['RUPEES', { amount: 100 }, 'PLAN_PRICE_CURRENCY_INVALID'],
        ['KWD', { amount: 1000 }, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
        ['bhd', { amount: 1000 }, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
        ['IQD', { amount: 1000 }, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
        ['XDR', { amount: 1000 }, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
        // Whole units only: PayPal takes no decimals on these.
        ['HUF', { amount: 349950 }, 'PLAN_PRICE_AMOUNT_INVALID'],
        ['twd', { amount: 59901 }, 'PLAN_PRICE_AMOUNT_INVALID'],
        ['INR', { amount: 0 }, 'BAD_REQUEST'],
        ['INR', { amount: 10.5 }, 'BAD_REQUEST'],
        // No amount and no existing price: there is nothing to keep.
        ['INR', {}, 'PLAN_PRICE_AMOUNT_INVALID'],
        ['INR', { amount: 100, countries: ['IND'] }, 'PLAN_PRICE_COUNTRY_INVALID'],
      ];
      for (const [currency, body, code] of cases) {
        const res = await putPrice(currency, body);
        expect(res.statusCode, `${currency} ${JSON.stringify(body)}: ${res.body}`).toBe(400);
        expect(res.json().error.code).toBe(code);
        expect(res.json().error.fix).toBeTruthy();
      }
      expect(await prisma.planPrice.count({ where: { currency: { not: 'USD' } } })).toBe(0);
    });

    it('changes the countries of an existing price without being sent its amount', async () => {
      expect((await putPrice('INR', { amount: 149900 })).statusCode).toBe(200);
      const res = await putPrice('INR', { countries: ['in', 'NP'] });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ currency: 'INR', amount: 149900, countries: ['IN', 'NP'], isDefault: false });
    });

    it('freezes the amount once a provider has registered the price, and still takes countries', async () => {
      await putPrice('INR', { amount: 149900 });
      // The stored provider id alone freezes it, whatever the status column says.
      await prisma.planPrice.updateMany({ where: { currency: 'INR' }, data: { metadata: { razorpay: { planId: 'plan_live', mode: 'test' } } } });

      const repriced = await putPrice('INR', { amount: 99900, countries: ['IN'] });
      expect(repriced.statusCode).toBe(409);
      expect(repriced.json().error.code).toBe('PLAN_PRICE_IMMUTABLE');
      expect(await prisma.planPrice.findFirstOrThrow({ where: { currency: 'INR' } })).toMatchObject({ amount: 149900, countries: [] });

      const moved = await putPrice('INR', { amount: 149900, countries: ['IN', 'NP'] });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().data).toMatchObject({ currency: 'INR', amount: 149900, countries: ['IN', 'NP'] });
    });

    it('freezes the amount while a checkout is registering the price', async () => {
      await putPrice('INR', { amount: 149900 });
      await prisma.planPrice.updateMany({ where: { currency: 'INR' }, data: { registrationStatus: 'PENDING' } });
      const res = await putPrice('INR', { amount: 99900 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PLAN_PRICE_IMMUTABLE');
      expect((await prisma.planPrice.findFirstOrThrow({ where: { currency: 'INR' } })).amount).toBe(149900);
    });

    it('refuses to make an additional currency the default one', async () => {
      await putPrice('INR', { amount: 149900 });
      await prisma.plan.update({ where: { id: planId }, data: { metadata: {} } });
      const res = await operator('PATCH', '/plans/pro', { price: { currency: 'INR', amount: 149900 } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PLAN_PRICE_IS_DEFAULT');
      expect((await prisma.plan.findUniqueOrThrow({ where: { id: planId } })).currency).toBe('USD');
    });

    it('deletes a price nobody is on, and 404s the second time', async () => {
      await putPrice('INR', { amount: 149900 });
      const res = await operator('DELETE', `/plans/${planId}/prices/inr`);
      expect(res.statusCode, res.body).toBe(200);
      expect(await prisma.planPrice.count({ where: { currency: { not: 'USD' } } })).toBe(0);
      const again = await operator('DELETE', `/plans/${planId}/prices/INR`);
      expect(again.statusCode).toBe(404);
      expect(again.json().error.code).toBe('PLAN_PRICE_NOT_FOUND');
    });

    it('refuses to delete a price an open checkout or a live subscription is on', async () => {
      await putPrice('INR', { amount: 149900 });
      const { row } = await sessionOf(await checkout({ country: 'IN' }));
      expect(row.planPriceId).not.toBeNull();

      const open = await operator('DELETE', `/plans/${planId}/prices/INR`);
      expect(open.statusCode).toBe(409);
      expect(open.json().error).toMatchObject({ code: 'PLAN_PRICE_IN_USE' });
      expect(open.json().error.message).toContain('1 open checkout');

      await prisma.checkoutSession.update({ where: { id: row.id }, data: { status: 'COMPLETE' } });
      await prisma.subscription.update({ where: { id: row.subscriptionId }, data: { status: 'ACTIVE', planPriceId: row.planPriceId, currency: 'INR', unitAmount: 149900 } });
      const live = await operator('DELETE', `/plans/${planId}/prices/INR`);
      expect(live.statusCode).toBe(409);
      expect(live.json().error.message).toContain('1 live subscription');

      await prisma.subscription.update({ where: { id: row.subscriptionId }, data: { status: 'CANCELED' } });
      expect((await operator('DELETE', `/plans/${planId}/prices/INR`)).statusCode).toBe(200);
    });

    it('needs an operator session', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${applicationId}/plans/${planId}/prices/INR`,
        headers: { authorization: `Bearer ${secretKey}` },
        payload: { amount: 100 },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('checkout', () => {
    function razorpayWebhook(body: object) {
      const payload = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/razorpay/${slug}`,
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': createHmac('sha256', RZP_WEBHOOK_SECRET).update(payload).digest('hex'),
        },
        payload,
      });
    }

    beforeEach(async () => {
      const res = await putPrice('INR', { amount: 149900 });
      expect(res.statusCode, res.body).toBe(200);
    });

    it('charges the INR price through the provider that can charge INR, and the subscription keeps it', async () => {
      const register = vi.spyOn(fakeRazorpay, 'ensurePlanRegistered');
      const price = await prisma.planPrice.findFirstOrThrow({ where: { currency: 'INR' } });

      const { provider, row } = await sessionOf(await checkout({ country: 'IN' }));
      expect(provider).toBe('razorpay');
      expect(row).toMatchObject({
        currency: 'INR',
        unitAmount: 149900,
        planPriceId: price.id,
        buyerCountry: 'IN',
        buyerCountrySource: 'declared',
      });
      // What the adapter was handed is what the buyer pays.
      expect(fakeRazorpay.lastCheckout!.plan).toMatchObject({
        id: planId,
        currency: 'INR',
        amount: 149900,
        planPriceId: price.id,
        registration: { razorpay: { planId: 'plan_stub_pro', mode: 'test' } },
      });
      // The plan's own registration is the default price's and is untouched.
      expect((await prisma.plan.findUniqueOrThrow({ where: { id: planId } })).metadata).not.toHaveProperty('razorpay');
      expect(await prisma.planPrice.findFirstOrThrow({ where: { currency: 'INR' } })).toMatchObject({
        registrationStatus: 'REGISTERED',
        metadata: { razorpay: { planId: 'plan_stub_pro', mode: 'test' } },
      });

      // Opening a checkout writes no price on the subscription.
      expect(await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } })).toMatchObject({
        currency: null,
        unitAmount: null,
        planPriceId: null,
      });
      const hook = await razorpayWebhook({
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: row.providerSessionId, status: 'active' } } },
      });
      expect(hook.statusCode, hook.body).toBe(200);
      expect(await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } })).toMatchObject({
        status: 'ACTIVE',
        currency: 'INR',
        unitAmount: 149900,
        planPriceId: price.id,
      });

      // A second buyer reuses the stored registration: Razorpay mints one plan.
      await sessionOf(await checkout({ country: 'IN' }, { user: await newBuyer() }));
      expect(register).toHaveBeenCalledTimes(1);
    });

    it('records a first INR payment that arrives before the completion', async () => {
      const { row } = await sessionOf(await checkout({ country: 'IN' }));
      // A newer checkout on the same subscription, at the default price: the
      // INR charge still has to find the INR session it pays.
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { currencies: ['INR', 'USD'] } });
      const newer = await sessionOf(await checkout({ provider: 'razorpay', currency: 'USD' }));
      expect(newer.row).toMatchObject({ subscriptionId: row.subscriptionId, currency: 'USD', unitAmount: 2000 });
      const charged = (id: string, currency: string) =>
        razorpayWebhook({
          event: 'subscription.charged',
          payload: {
            subscription: { entity: { id: row.providerSessionId, status: 'active', paid_count: 1 } },
            payment: { entity: { id, amount: 149900, currency } },
          },
        });

      // A charge in a currency the checkout it names was not opened at is
      // recorded unverified, and activates nothing.
      expect((await charged('pay_eur_1', 'EUR')).statusCode).toBe(200);
      expect(await prisma.payment.findMany()).toMatchObject([
        { providerPaymentId: 'pay_eur_1', currency: 'EUR', verification: 'UNVERIFIED', subscriptionId: null },
      ]);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } })).status).toBe('PENDING');

      expect((await charged('pay_inr_1', 'INR')).statusCode).toBe(200);
      expect(await prisma.payment.findFirstOrThrow({ where: { providerPaymentId: 'pay_inr_1' } })).toMatchObject({
        amount: 149900,
        currency: 'INR',
        status: 'SUCCEEDED',
        subscriptionId: row.subscriptionId,
      });
    });

    // Two shapes, because each one gets past a different half of the guard. A
    // slow provider lets the others arrive while one registers, which the
    // claim has to stop. An instant one finishes between another checkout's
    // read and its claim, which the read under the claim has to catch.
    it.each([
      ['a slow provider', 150],
      ['an instant provider', 0],
    ])('registers the price once when first checkouts race, with %s', async (_label, delayMs) => {
      const register = vi.spyOn(fakeRazorpay, 'ensurePlanRegistered').mockImplementation(async () => {
        if (delayMs > 0) await sleep(delayMs);
        return { providerPlanId: 'plan_slow' };
      });
      const buyers = await Promise.all(Array.from({ length: 6 }, () => newBuyer()));
      const results = await Promise.all(buyers.map((user) => checkout({ country: 'IN' }, { user })));
      expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
      expect(register).toHaveBeenCalledTimes(1);
      expect(await prisma.planPrice.findFirstOrThrow({ where: { currency: 'INR' } })).toMatchObject({
        registrationStatus: 'REGISTERED',
        metadata: { razorpay: { planId: 'plan_slow', mode: 'test' } },
      });
    });

    it('gives a hint country the default price under `trusted`, and the local one under `any`', async () => {
      const hinted = await sessionOf(await checkout({ country: 'IN' }, { key: publishableKey }));
      expect(hinted.row).toMatchObject({ currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceId(), buyerCountrySource: 'hint' });
      expect(hinted.provider).toBe('stripe');

      const patched = await operator('PATCH', '/billing-config', { localPrices: 'any' });
      expect(patched.statusCode, patched.body).toBe(200);
      const local = await sessionOf(await checkout({ country: 'IN' }, { key: publishableKey, user: await newBuyer() }));
      expect(local.row).toMatchObject({ currency: 'INR', unitAmount: 149900, buyerCountrySource: 'hint' });
      expect(local.provider).toBe('razorpay');
    });

    it('charges the default price when no country is declared', async () => {
      const { provider, row } = await sessionOf(await checkout());
      expect(provider).toBe('stripe');
      expect(row).toMatchObject({ currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceId() });
    });

    it('rejects `currency` from a publishable key, and opens nothing', async () => {
      const res = await checkout({ currency: 'INR' }, { key: publishableKey });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BILLING_CURRENCY_NOT_ALLOWED');
      expect(await prisma.checkoutSession.count()).toBe(0);
      expect(await prisma.subscription.count()).toBe(0);
    });

    it('honours `currency` from a secret key, and refuses one the plan is not priced in', async () => {
      const { provider, row } = await sessionOf(await checkout({ currency: 'inr' }));
      expect(provider).toBe('razorpay');
      expect(row).toMatchObject({ currency: 'INR', unitAmount: 149900 });

      const res = await checkout({ currency: 'EUR' }, { user: await newBuyer() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BILLING_PLAN_CURRENCY_UNAVAILABLE');
    });

    it('says in the response which currency and price the checkout charges', async () => {
      const local = await checkout({ country: 'IN' });
      expect(local.json().data).toMatchObject({ currency: 'INR', unitAmount: 149900 });
      const standard = await checkout({}, { user: await newBuyer() });
      expect(standard.json().data).toMatchObject({ currency: 'USD', unitAmount: 2000 });
    });

    it('charges the default price for a currency the server named and its provider cannot charge, and logs it', async () => {
      const res = await checkout({ currency: 'INR', provider: 'stripe' });
      const { provider, row } = await sessionOf(res);
      expect(provider).toBe('stripe');
      expect(row).toMatchObject({ currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceId() });
      const inr = await prisma.planPrice.findFirstOrThrow({ where: { planId, currency: 'INR' } });
      expect(res.json().data).toMatchObject({
        price: { id: await defaultPriceId(), currency: 'USD', amount: 2000, formatted: '$20.00', isDefault: true, reason: 'fallback' },
        priceFallback: {
          requested: { id: inr.id, currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
          charged: { id: await defaultPriceId(), currency: 'USD', amount: 2000, formatted: '$20.00' },
          reason: 'no_provider_for_currency',
        },
      });
      expect(await fallbackEvents()).toHaveLength(1);
    });

    it('refuses that currency instead when the server passes onUnavailableCurrency: refuse', async () => {
      const named = await checkout({ currency: 'INR', provider: 'stripe', onUnavailableCurrency: 'refuse' });
      expect(named.statusCode).toBe(400);
      expect(named.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');
      expect(await prisma.checkoutSession.count()).toBe(0);
      expect(await fallbackEvents()).toEqual([]);
    });

    it('refuses a named currency that is not the one the buyer already pays in', async () => {
      const first = await sessionOf(await checkout({ country: 'IN' }));
      await razorpayWebhook({
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: first.row.providerSessionId, status: 'active' } } },
      });
      await createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
      expect((await putPrice('INR', { amount: 399900 }, 'team')).statusCode).toBe(200);
      const res = await checkout({ planSlug: 'team', currency: 'USD' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BILLING_CURRENCY_CONFLICT');
    });

    it('does not let an unpaid checkout on another plan carry its currency over', async () => {
      // A plan whose DEFAULT currency is the cheap one, opened and never paid.
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { countries: [] } });
      await createPlan({ slug: 'india', name: 'India', price: { currency: 'INR', amount: 49900 } });
      const unpaid = await sessionOf(await checkout({ planSlug: 'india' }, { key: publishableKey }));
      expect(unpaid.row.currency).toBe('INR');

      // The same buyer, a browser caller with no believed country, on the USD plan.
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { currencies: ['INR', 'USD'] } });
      const next = await checkout({ planSlug: 'pro' }, { key: publishableKey });
      expect(next.statusCode, next.body).toBe(200);
      expect(next.json().data).toMatchObject({ currency: 'USD', unitAmount: 2000 });
    });

    it('refuses a price registered in the other mode, naming the repair', async () => {
      await sessionOf(await checkout({ country: 'IN' }));
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { mode: 'live' } });
      const res = await checkout({ country: 'IN' }, { user: await newBuyer() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BILLING_PLAN_PRICE_MODE_MISMATCH');
      expect(res.json().error.fix).toContain('Remove the INR price and add it again');
    });

    it('falls back to the default price when no provider can charge the local one', async () => {
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { enabled: false } });
      const res = await checkout({ country: 'IN' });
      const { provider, row } = await sessionOf(res);
      expect(provider).toBe('stripe');
      expect(row).toMatchObject({ currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceId() });
      expect(res.json().data.price).toMatchObject({ currency: 'USD', amount: 2000, reason: 'fallback', requestedCurrency: 'INR' });
      expect(res.json().data.priceFallback).toMatchObject({ requested: { currency: 'INR', amount: 149900 }, charged: { currency: 'USD' } });
    });

    it('sends every field of the checkout result on the wire, with and without a fallback', async () => {
      const direct = (await checkout({ country: 'IN' })).json().data as Record<string, unknown>;
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { enabled: false } });
      const fellBack = (await checkout({ country: 'IN' }, { user: await newBuyer() })).json().data as Record<string, unknown>;
      for (const data of [direct, fellBack]) {
        // None of these is optional any more: the schema refuses a result without one.
        for (const field of ['currency', 'unitAmount', 'warnings', 'mode', 'checkoutSessionId', 'price', 'priceFallback']) {
          expect(data, field).toHaveProperty(field);
        }
        expect(CheckoutResultDtoSchema.safeParse(data).error?.issues ?? []).toEqual([]);
      }
      expect(Array.isArray(direct.warnings)).toBe(true);
      expect(direct).toMatchObject({ currency: 'INR', unitAmount: 149900, mode: 'redirect', price: { reason: 'country', requestedCurrency: null } });
      expect(fellBack).toMatchObject({ currency: 'USD', unitAmount: 2000, price: { reason: 'fallback', requestedCurrency: 'INR' } });
    });

    it('lists the public plan with its resolved price and no amount or currency of its own', async () => {
      const read = (country: string) =>
        app.inject({ method: 'GET', url: `/api/v1/billing/plans?country=${country}`, headers: { authorization: `Bearer ${secretKey}` } });
      const local = await read('IN');
      expect(PagedSchema(PublicPlanDtoSchema).safeParse(local.json().data).error?.issues ?? []).toEqual([]);
      const pro = (local.json().data.items as Array<Record<string, unknown>>).find((plan) => plan.slug === 'pro')!;
      expect(pro).not.toHaveProperty('amount');
      expect(pro).not.toHaveProperty('currency');
      expect(pro.price).toMatchObject({ currency: 'INR', amount: 149900, reason: 'country', requestedCurrency: null });

      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { enabled: false } });
      const fallback = await read('IN');
      const shown = (fallback.json().data.items as Array<Record<string, unknown>>).find((plan) => plan.slug === 'pro')!;
      expect(shown.price).toMatchObject({ currency: 'USD', amount: 2000, reason: 'fallback', requestedCurrency: 'INR' });
    });

    it('writes one checkout.price_fallback event per fallback, with the session, both prices and where the buyer was', async () => {
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { enabled: false } });
      const { row } = await sessionOf(await checkout({ country: 'IN' }));
      const inr = await prisma.planPrice.findFirstOrThrow({ where: { planId, currency: 'INR' } });
      const events = await fallbackEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tier: 'PERMANENT',
        checkoutSessionId: row.id,
        subscriptionId: row.subscriptionId,
        endUserId: row.endUserId,
        planId,
        planPriceId: await defaultPriceId(),
        provider: 'stripe',
        currency: 'USD',
        amount: 2000,
        data: {
          planSlug: 'pro',
          requested: { planPriceId: inr.id, currency: 'INR', amount: 149900 },
          charged: { planPriceId: await defaultPriceId(), currency: 'USD', amount: 2000 },
          reason: 'no_provider_for_currency',
          buyerCountry: 'IN',
          buyerCountrySource: 'declared',
        },
      });
    });

    it('says the price charged and no fallback when the price selected is charged', async () => {
      const res = await checkout({ country: 'IN' });
      const inr = await prisma.planPrice.findFirstOrThrow({ where: { planId, currency: 'INR' } });
      expect(res.json().data).toMatchObject({
        price: { id: inr.id, currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'country', requestedCurrency: null },
        priceFallback: null,
      });
      expect(await fallbackEvents()).toEqual([]);
    });

    it('charges the default price through a provider the server named that cannot charge the local one', async () => {
      const { provider, row } = await sessionOf(await checkout({ country: 'IN', provider: 'stripe' }));
      expect(provider).toBe('stripe');
      expect(row).toMatchObject({ currency: 'USD', unitAmount: 2000, planPriceId: await defaultPriceId() });
      expect(await fallbackEvents()).toHaveLength(1);
    });

    it('does not let a browser pick the default price by naming a provider that cannot charge the local one', async () => {
      const patched = await operator('PATCH', '/billing-config', { localPrices: 'any' });
      expect(patched.statusCode, patched.body).toBe(200);
      const unnamed = await sessionOf(await checkout({ country: 'IN' }, { key: publishableKey }));
      expect(unnamed.row).toMatchObject({ currency: 'INR', unitAmount: 149900 });

      const named = await sessionOf(
        await checkout({ country: 'IN', provider: 'stripe' }, { key: publishableKey, user: await newBuyer() }),
      );
      expect(named.provider).toBe('razorpay');
      expect(named.row).toMatchObject({ currency: 'INR', unitAmount: 149900 });
      expect(await fallbackEvents()).toEqual([]);
    });

    it('refuses a subscriber whose currency their provider can no longer charge, and never moves them to the default', async () => {
      const first = await sessionOf(await checkout({ country: 'IN' }));
      await razorpayWebhook({
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: first.row.providerSessionId, status: 'active' } } },
      });
      await createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
      expect((await putPrice('INR', { amount: 399900 }, 'team')).statusCode).toBe(200);
      await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { currencies: ['USD'] } });

      const before = await prisma.checkoutSession.count();
      const res = await checkout({ planSlug: 'team' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'BILLING_CURRENCY_CONFLICT' });
      expect(res.json().error.message).toContain('INR');
      expect(res.json().error.fix).toContain('Add INR to the currencies of "razorpay"');
      expect(await prisma.checkoutSession.count()).toBe(before);
      expect(await fallbackEvents()).toEqual([]);
    });

    it('keeps a subscriber on the currency they already pay in', async () => {
      const first = await sessionOf(await checkout({ country: 'IN' }));
      await razorpayWebhook({
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: first.row.providerSessionId, status: 'active' } } },
      });
      await createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
      expect((await putPrice('INR', { amount: 399900 }, 'team')).statusCode).toBe(200);

      // No country this time: without the binding this would be the USD price.
      const second = await sessionOf(await checkout({ planSlug: 'team' }));
      expect(second.provider).toBe('razorpay');
      expect(second.row).toMatchObject({ currency: 'INR', unitAmount: 399900 });
    });

    describe('coupons, on a one-time purchase', () => {
      beforeEach(async () => {
        await createPlan({ slug: 'pack', name: '100 credits', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 100 });
        expect((await putPrice('INR', { amount: 79900 }, 'pack')).statusCode).toBe(200);
        for (const coupon of [
          { code: 'HALF', discountType: 'PERCENT', basisPoints: 5000 },
          { code: 'FIVEUSD', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 500 }] },
        ]) {
          const res = await operator('POST', '/coupons', coupon);
          expect(res.statusCode, res.body).toBe(201);
        }
      });

      it('applies a percent coupon to the INR price', async () => {
        const res = await checkout({ planSlug: 'pack', country: 'IN', couponCode: 'HALF' });
        const { provider, row } = await sessionOf(res);
        expect(provider).toBe('razorpay');
        expect(res.json().data.discountAmount).toBe(39950);
        expect(row).toMatchObject({ currency: 'INR', unitAmount: 79900 });
        expect(row).toMatchObject({ chargeAmount: 39950, discountAmount: 39950, currency: 'INR' });
        expect(row.metadata).not.toHaveProperty('expectedCharge');
      });

      it('refuses a fixed-amount USD coupon on the INR price, and takes it on the USD one', async () => {
        const refused = await checkout({ planSlug: 'pack', country: 'IN', couponCode: 'FIVEUSD' });
        expect(refused.statusCode).toBe(400);
        expect(refused.json().error.code).toBe('COUPON_CURRENCY_NOT_COVERED');
        expect(await prisma.checkoutSession.count()).toBe(0);

        const res = await checkout({ planSlug: 'pack', couponCode: 'FIVEUSD' });
        const { provider, row } = await sessionOf(res);
        expect(provider).toBe('stripe');
        expect(row).toMatchObject({ chargeAmount: 500, currency: 'USD' });
      });

      it('judges a fixed-amount coupon on the default price after a fall back to it', async () => {
        await prisma.billingCredentials.updateMany({ where: { provider: 'razorpay' }, data: { enabled: false } });
        const res = await checkout({ planSlug: 'pack', country: 'IN', couponCode: 'FIVEUSD' });
        const { row } = await sessionOf(res);
        expect(row).toMatchObject({ currency: 'USD', unitAmount: 1000 });
        expect(res.json().data.discountAmount).toBe(500);
      });
    });
  });

  describe('plan readiness', () => {
    it('reports a plan no provider can charge in any of its currencies, and clears once one can', async () => {
      await createPlan({ slug: 'eu', name: 'EU', price: { currency: 'EUR', amount: 1800 } });
      const blockersOf = async () => {
        const listed = await operator('GET', '/plans');
        const plan = (listed.json().data as { items: Array<{ slug: string; checkout: { blockers: Array<{ code: string }> } }> }).items.find(
          (p) => p.slug === 'eu',
        )!;
        return plan.checkout.blockers.map((b) => b.code);
      };
      expect(await blockersOf()).toContain('PLAN_CURRENCY_UNSUPPORTED');
      expect((await putPrice('GBP', { amount: 1600 }, 'eu')).statusCode).toBe(200);
      expect(await blockersOf()).toContain('PLAN_CURRENCY_UNSUPPORTED');
      // A chargeable local price does not make up for a default nobody can
      // be charged: every buyer without a local price pays the default.
      expect((await putPrice('INR', { amount: 149900 }, 'eu')).statusCode).toBe(200);
      expect(await blockersOf()).toContain('PLAN_CURRENCY_UNSUPPORTED');
      await billingCredentialsService.setCurrencies(applicationId, 'stripe', ['USD', 'EUR']);
      expect(await blockersOf()).not.toContain('PLAN_CURRENCY_UNSUPPORTED');
    });
  });
});
