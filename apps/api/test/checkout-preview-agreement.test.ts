/**
 * Everything that answers ahead of a checkout agrees with the checkout: the
 * provider list, the coupon preview and trial eligibility read the price and
 * the provider the same way `POST /billing/checkout` does.
 *
 * The world: `pro` costs USD 20.00 by default and INR 1,499.00 as a local
 * price. Stripe charges USD only; Razorpay charges INR only and is preferred
 * in India.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { countQueries } from './query-counter.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

const HINT = { 'x-rekey-visitor-country-hint': 'IN' };

describe('previews agree with the checkout they predict', () => {
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

  async function setBillingConfig(patch: Record<string, string>): Promise<void> {
    const current = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
    await prisma.application.update({
      where: { id: w.applicationId },
      data: { billingConfig: { ...(current.billingConfig as object), ...patch } },
    });
  }

  /** A billing route called with the secret key and extra headers, as an SDK on the operator's server would. */
  function withHeaders(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown>,
    buyer: Buyer = w.buyer,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method,
      url: `/api/v1/billing${url}`,
      headers: { authorization: `Bearer ${w.secretKey}`, 'x-rekey-user-token': buyer.token, ...headers },
      ...(payload !== undefined && { payload }),
    });
  }
  const checkoutBody = (extra: Record<string, unknown> = {}) => ({
    planSlug: 'pro',
    successUrl: 'https://app.example/account?paid=1',
    cancelUrl: 'https://app.example/account',
    ...extra,
  });

  describe('GET /billing/providers?planSlug=', () => {
    async function providers(query: string, key = w.secretKey) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/billing/providers${query}`,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data as { routedProvider: string | null; providers: Array<{ provider: string }> };
      return { routed: data.routedProvider, names: data.providers.map((p) => p.provider) };
    }

    it('routes a buyer in India to the provider that charges the local price, as an unnamed checkout does', async () => {
      const list = await providers('?planSlug=pro&country=IN');
      expect(list.routed).toBe('razorpay');
      // Stripe is still offered: naming it is accepted, at the default price.
      expect(list.names).toEqual(['razorpay', 'stripe']);

      const unnamed = await w.sessionOf(await w.checkout({ country: 'IN' }));
      expect(unnamed.provider).toBe(list.routed);
      expect(unnamed.row.currency).toBe('INR');
      const named = await w.sessionOf(await w.checkout({ country: 'IN', provider: 'stripe' }, { buyer: await w.newBuyer() }));
      expect(named).toMatchObject({ provider: 'stripe', row: { currency: 'USD', unitAmount: 2000 } });
    });

    it('leaves out a provider that could only charge a local price this buyer is not offered', async () => {
      const list = await providers('?planSlug=pro&country=US');
      expect(list).toEqual({ routed: 'stripe', names: ['stripe'] });
      const refused = await w.checkout({ country: 'US', provider: 'razorpay' });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('BILLING_PROVIDER_CURRENCY_UNSUPPORTED');
    });

    it('does not let a country a browser states choose the local price or its provider', async () => {
      const list = await providers('?planSlug=pro&country=IN', w.publishableKey);
      expect(list.routed).toBe('stripe');
      const bought = await w.sessionOf(await w.checkout({ country: 'IN' }, { key: w.publishableKey }));
      expect(bought).toMatchObject({ provider: 'stripe', row: { currency: 'USD' } });
    });
  });

  describe('POST /billing/coupons/validate', () => {
    beforeEach(async () => {
      const res = await w.operator('POST', '/coupons', { code: 'HALF', discountType: 'PERCENT', basisPoints: 5000 });
      expect(res.statusCode, res.body).toBe(201);
      // A one-time pack: both providers honour a coupon on a one-off charge.
      await w.createPlan({ slug: 'pack', name: '100 credits', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 100 });
      await w.putPrice('pack', 'INR', 79900);
    });

    const preview = (body: Record<string, unknown>, buyer: Buyer = w.buyer) =>
      w.asBuyer('POST', '/coupons/validate', { code: 'HALF', planSlug: 'pack', ...body }, { buyer });

    it('quotes at the price the named provider can charge, as the checkout that names it does', async () => {
      const quoted = await preview({ country: 'IN', provider: 'stripe' });
      expect(quoted.statusCode, quoted.body).toBe(200);
      expect(quoted.json().data).toMatchObject({ currency: 'USD', amount: 1000, discountAmount: 500 });
      const bought = await w.checkout({ planSlug: 'pack', couponCode: 'HALF', country: 'IN', provider: 'stripe' });
      expect(bought.json().data).toMatchObject({ provider: 'stripe', currency: 'USD', discountAmount: 500 });

      // And with no provider named the same buyer is quoted, and charged, in rupees.
      const other = await preview({ country: 'IN' }, await w.newBuyer());
      expect(other.json().data).toMatchObject({ currency: 'INR', discountAmount: 39950 });
    });

    it('refuses a provider the checkout would refuse, with the same code', async () => {
      const quoted = await preview({ country: 'US', provider: 'razorpay' });
      const bought = await w.checkout({ planSlug: 'pack', couponCode: 'HALF', country: 'US', provider: 'razorpay' });
      expect(bought.statusCode).toBe(400);
      expect(quoted.statusCode).toBe(bought.statusCode);
      expect(quoted.json().error.code).toBe(bought.json().error.code);
    });

    describe('for an Application that bills per organization', () => {
      let orgId: string;

      beforeEach(async () => {
        await setBillingConfig({ billingSubject: 'org' });
        const org = await prisma.organization.create({
          data: { applicationId: w.applicationId, name: 'Acme', slug: `acme-${Math.random().toString(36).slice(2, 8)}` },
        });
        orgId = org.id;
        await prisma.organizationMembership.create({
          data: { organizationId: orgId, endUserId: w.buyer.id, role: 'OWNER' },
        });
      });

      it('quotes in the currency the organization already pays in, as its checkout charges', async () => {
        const first = await w.sessionOf(await w.checkout({ country: 'IN', organizationId: orgId }));
        await w.razorpayWebhook({
          event: 'subscription.activated',
          payload: { subscription: { entity: { id: first.row.providerSessionId, status: 'active' } } },
        });
        await w.createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
        await w.putPrice('team', 'INR', 399900);
        // A colleague buys another plan for the same organization, with no
        // country given: nothing of their own binds them, the organization does.
        const colleague = await w.newBuyer();
        await prisma.organizationMembership.create({
          data: { organizationId: orgId, endUserId: colleague.id, role: 'ADMIN' },
        });
        // The organization's provider cannot discount one period of a
        // subscription, so the quote refuses exactly as the checkout with the code does.
        const quoted = await preview({ planSlug: 'team', organizationId: orgId }, colleague);
        const refused = await w.checkout({ planSlug: 'team', organizationId: orgId, couponCode: 'HALF' }, { buyer: colleague });
        expect(refused.statusCode).toBe(400);
        expect(quoted.statusCode).toBe(refused.statusCode);
        expect(quoted.json().error).toMatchObject({ code: 'BILLING_DISCOUNT_UNSUPPORTED', details: expect.objectContaining({ provider: 'razorpay' }) });
        expect(quoted.json().error.code).toBe(refused.json().error.code);
        const bought = await w.checkout({ planSlug: 'team', organizationId: orgId }, { buyer: colleague });
        expect(bought.json().data).toMatchObject({ provider: 'razorpay', currency: 'INR', unitAmount: 399900 });
      });

      it('refuses an organization the caller may not buy for, and a missing one, exactly as checkout does', async () => {
        const outsider = await w.newBuyer();
        for (const body of [{ organizationId: orgId }, {}]) {
          const quoted = await preview(body, outsider);
          const bought = await w.checkout({ planSlug: 'pack', couponCode: 'HALF', ...body }, { buyer: outsider });
          expect(bought.statusCode).toBeGreaterThanOrEqual(400);
          expect(quoted.statusCode).toBe(bought.statusCode);
          expect(quoted.json().error.code).toBe(bought.json().error.code);
        }
        expect((await preview({}, outsider)).json().error.code).toBe('BILLING_ORGANIZATION_REQUIRED');
      });
    });

    it('refuses an organization on an Application that bills per user, as checkout does', async () => {
      const quoted = await preview({ organizationId: 'org_none' });
      const bought = await w.checkout({ planSlug: 'pack', organizationId: 'org_none' });
      expect(quoted.statusCode).toBe(bought.statusCode);
      expect(quoted.json().error.code).toBe(bought.json().error.code);
    });
  });

  describe("the visitor country hint an SDK forwards from the operator's server", () => {
    beforeEach(async () => {
      const res = await w.operator('POST', '/coupons', { code: 'HALF', discountType: 'PERCENT', basisPoints: 5000 });
      expect(res.statusCode, res.body).toBe(201);
      await w.createPlan({ slug: 'trial', name: 'Trial', price: { currency: 'USD', amount: 4000 }, trialDays: 14 });
      await w.putPrice('trial', 'INR', 299900);
    });

    const trialProvider = async (): Promise<string | undefined> => {
      const res = await withHeaders('GET', '/trial-eligibility?planSlug=trial', HINT);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().data as { items: Array<{ provider?: string }> }).items[0]!.provider;
    };

    it('routes but never selects the local price while `localPrices` is `trusted`', async () => {
      const bought = await w.sessionOf(await withHeaders('POST', '/checkout', HINT, checkoutBody()));
      expect(bought.provider).toBe('stripe');
      expect(bought.row).toMatchObject({ currency: 'USD', unitAmount: 2000, buyerCountry: 'IN', buyerCountrySource: 'hint' });

      const quoted = await withHeaders('POST', '/coupons/validate', HINT, { code: 'HALF', planSlug: 'pro' }, await w.newBuyer());
      expect(quoted.json().data).toMatchObject({ currency: 'USD', amount: 2000, discountAmount: 1000 });

      // Stripe runs the trial on the default price; Razorpay would not.
      expect(await trialProvider()).toBe('stripe');
    });

    it('selects the local price once the Application sets `localPrices` to `any`', async () => {
      await setBillingConfig({ localPrices: 'any' });
      const bought = await w.sessionOf(await withHeaders('POST', '/checkout', HINT, checkoutBody()));
      expect(bought.provider).toBe('razorpay');
      expect(bought.row).toMatchObject({ currency: 'INR', unitAmount: 149900, buyerCountry: 'IN', buyerCountrySource: 'hint' });

      // Razorpay charges the local price and cannot discount one period of a
      // subscription: the quote says what the checkout with the code would.
      const other = await w.newBuyer();
      const quoted = await withHeaders('POST', '/coupons/validate', HINT, { code: 'HALF', planSlug: 'pro' }, other);
      const refused = await withHeaders('POST', '/checkout', HINT, checkoutBody({ couponCode: 'HALF' }), other);
      expect(quoted.json().error).toMatchObject({ code: 'BILLING_DISCOUNT_UNSUPPORTED', details: expect.objectContaining({ provider: 'razorpay' }) });
      expect(refused.json().error.code).toBe(quoted.json().error.code);

      expect(await trialProvider()).toBe('razorpay');
    });

    it('loses to a country the operator declares', async () => {
      await setBillingConfig({ localPrices: 'any' });
      const bought = await w.sessionOf(await withHeaders('POST', '/checkout', HINT, checkoutBody({ country: 'US' })));
      expect(bought.row).toMatchObject({ currency: 'USD', buyerCountry: 'US', buyerCountrySource: 'declared' });
    });
  });

  describe('GET /billing/trial-eligibility query budget', () => {
    const addTrialPlans = async (from: number, to: number): Promise<void> => {
      for (let i = from; i < to; i += 1) {
        await w.createPlan({ slug: `t${i}`, name: `Trial ${i}`, price: { currency: 'USD', amount: 3000 + i }, trialDays: 14 });
        await w.putPrice(`t${i}`, 'INR', 250000 + i);
      }
    };
    const measure = async (): Promise<number> => {
      // Warm the key and session caches so only the route's own reads are counted.
      await w.asBuyer('GET', '/trial-eligibility?country=IN');
      const counted = await countQueries(async () => {
        const res = await w.asBuyer('GET', '/trial-eligibility?country=IN');
        expect(res.statusCode, res.body).toBe(200);
        expect((res.json().data as { items: unknown[] }).items.length).toBeGreaterThan(2);
      });
      return counted.count;
    };

    it('costs the same number of queries for seven trial plans as for two', async () => {
      await addTrialPlans(0, 2);
      const two = await measure();
      await addTrialPlans(2, 7);
      const seven = await measure();
      expect(seven).toBe(two);
    });
  });
});
