/**
 * Fixes from the hostile review of the money model foundation, each held at
 * the wire: what a publishable key can read of a plan, what a plan's default
 * price may be, and the default price row as the one source of a price.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resolvePlanPrices } from '../src/modules/billing/checkout-price-resolution.js';
import { completeCheckoutSession } from '../src/modules/billing/checkout/sessions.service.js';

const markCheckoutSessionComplete = (applicationId: string, providerSessionId: string) =>
  prisma.$transaction((tx) => completeCheckoutSession(tx, applicationId, providerSessionId, { actor: { type: 'system' } }));
import { withDefaultPrices } from '../src/modules/plans/default-price.js';
import { toProviderAmount as paypalWire } from '../src/modules/billing/providers/paypal-money.js';
import { toProviderAmount as stripeWire } from '../src/modules/billing/providers/stripe-money.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

describe('money model foundation: review fixes', () => {
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

  const catalogue = async (key: string, query = '') =>
    app
      .inject({ method: 'GET', url: `/api/v1/billing/plans${query}`, headers: { authorization: `Bearer ${key}` } })
      .then((res) => {
        expect(res.statusCode, res.body).toBe(200);
        return (res.json().data as { items: Array<Record<string, unknown>> }).items;
      });

  describe('the public catalogue', () => {
    const PLAN_KEYS = [
      'checkout',
      'creditsAmount',
      'id',
      'interval',
      'isFree',
      'kind',
      'licenseDurationDays',
      'licenseKind',
      'licenseSeatsAllowed',
      'meterSlug',
      'name',
      'price',
      'prices',
      'slug',
      'trialDays',
    ];
    const PRICE_KEYS = ['amount', 'archived', 'countries', 'currency', 'id', 'isDefault'];
    const RESOLVED_KEYS = ['amount', 'currency', 'formatted', 'id', 'isDefault', 'reason', 'requestedCurrency'];

    it('answers a publishable key with a pinned set of fields and nothing else, at every level', async () => {
      // Everything an operator-only field could carry, set to something recognisable.
      await prisma.planPrice.updateMany({
        where: { planId: w.planId },
        data: { metadata: { stripe: { priceId: 'price_LEAK', mode: 'test' } }, registrationStatus: 'FAILED', registrationError: 'LEAK: provider refusal text' },
      });
      await prisma.$executeRaw`UPDATE "plans" SET "metadata" = '{"stripe":{"priceId":"price_LEAK","mode":"test"},"internalNote":"LEAK"}'::jsonb,
        "registration_error" = 'LEAK: provider refusal text' WHERE "id" = ${w.planId}`;

      for (const key of [w.publishableKey, w.secretKey]) {
        const items = await catalogue(key);
        expect(items).toHaveLength(1);
        const [plan] = items;
        expect(Object.keys(plan!).sort()).toEqual(PLAN_KEYS);
        expect(plan!.checkout).toEqual({ ready: expect.any(Boolean) });
        expect(Object.keys(plan!.price as object).sort()).toEqual(RESOLVED_KEYS);
        for (const price of plan!.prices as object[]) expect(Object.keys(price).sort()).toEqual(PRICE_KEYS);
        expect(JSON.stringify(items)).not.toContain('LEAK');
        expect(JSON.stringify(items)).not.toContain(w.applicationId);
      }
    });

    it('still carries what a pricing page shows', async () => {
      await w.createPlan({ slug: 'pack', name: '100 credits', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 100 });
      await w.createPlan({ slug: 'free', name: 'Free', });
      const items = await catalogue(w.publishableKey);
      expect(items.find((plan) => plan.slug === 'pack')).toMatchObject({
        kind: 'CREDIT',
        creditsAmount: 100,
        price: { amount: 1000, currency: 'USD' },
        isFree: false,
      });
      expect(items.find((plan) => plan.slug === 'free')).toMatchObject({ isFree: true, price: null, prices: [] });
    });

    it('gives the operator the fields the public one is spared, as the schema names them', async () => {
      const res = await w.operator('GET', '/plans');
      expect(res.statusCode, res.body).toBe(200);
      const [plan] = (res.json().data as { items: Array<Record<string, unknown>> }).items;
      const { defaultPriceId } = await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } });
      expect(plan).toMatchObject({
        applicationId: w.applicationId,
        defaultPriceId,
        isFree: false,
        localPrices: 'INHERIT',
        registrationStatus: expect.any(String),
        registrationError: null,
        trialDays: null,
        price: { amount: 2000, currency: 'USD' },
      });
      expect(Object.keys(plan!).sort()).toEqual(
        [...PLAN_KEYS, 'active', 'applicationId', 'createdAt', 'defaultPriceId', 'localPrices', 'metadata', 'registrationError', 'registrationStatus', 'updatedAt'].sort(),
      );
    });
  });

  describe("a plan's default price", () => {
    it.each([
      ['KWD', 1005, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
      ['XAU', 1000, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
      ['ZZZ', 1000, 'PLAN_PRICE_CURRENCY_INVALID'],
      ['HUF', 150, 'PLAN_PRICE_AMOUNT_INVALID'],
      ['MGA', 2_147_483_647, 'PLAN_PRICE_AMOUNT_INVALID'],
    ])('is refused in %s at %d, as an additional price would be', async (currency, amount, code) => {
      const res = await w.operator('POST', '/plans', { slug: 'bad', name: 'Bad', price: { currency, amount } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe(code);
      expect(await prisma.plan.count({ where: { applicationId: w.applicationId, slug: 'bad' } })).toBe(0);
    });

    it('is stored upper-case whatever case it was sent in, on the plan and on the subscription that takes it', async () => {
      const res = await w.operator('POST', '/plans', { slug: 'lower', name: 'Lower', price: { currency: 'usd', amount: 900 } });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().data).toMatchObject({ price: { currency: 'USD', amount: 900 }, prices: [{ currency: 'USD', amount: 900, isDefault: true }] });
      const granted = await w.operator('POST', `/end-users/${w.buyer.id}/subscriptions`, { planSlug: 'lower' });
      expect(granted.statusCode, granted.body).toBe(201);
      const sub = await prisma.subscription.findFirstOrThrow({ where: { endUserId: w.buyer.id, plan: { slug: 'lower' } } });
      const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: w.applicationId, slug: 'lower' } });
      expect(sub).toMatchObject({ currency: 'USD', unitAmount: 900, planPriceId: plan.defaultPriceId });
    });

    it('holds the same rules on PATCH', async () => {
      // No Stripe credentials, so the plan is not registered and its price can still be edited.
      await prisma.billingCredentials.deleteMany({ where: { applicationId: w.applicationId, provider: 'stripe' } });
      await w.createPlan({ slug: 'edit', name: 'Edit', price: { currency: 'USD', amount: 550 } });
      for (const [body, code] of [
        [{ currency: 'KWD', amount: 550 }, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
        [{ currency: 'ZZZ', amount: 550 }, 'PLAN_PRICE_CURRENCY_INVALID'],
        [{ currency: 'HUF', amount: 150 }, 'PLAN_PRICE_AMOUNT_INVALID'],
        [{ currency: 'HUF', amount: 550 }, 'PLAN_PRICE_AMOUNT_INVALID'],
      ] as const) {
        const res = await w.operator('PATCH', '/plans/edit', { price: body });
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error.code, JSON.stringify(body)).toBe(code);
      }
      const ok = await w.operator('PATCH', '/plans/edit', { price: { currency: 'eur', amount: 550 } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().data).toMatchObject({ price: { currency: 'EUR', amount: 550 } });
    });
  });

  describe('the default price row is the price', () => {
    it('shows and charges the same amount after the plan column is written behind the API', async () => {
      // What an older build, or a person with database access, does.
      await prisma.$executeRaw`UPDATE "plans" SET "amount" = 2600 WHERE "id" = ${w.planId}`;

      const [plan] = await catalogue(w.publishableKey);
      const prices = plan!.prices as Array<{ amount: number; isDefault: boolean }>;
      const price = plan!.price as { amount: number };
      expect(price.amount).toBe(prices.find((row) => row.isDefault)!.amount);
      expect(plan).not.toHaveProperty('amount');

      const { row } = await w.sessionOf(await w.checkout());
      expect(row.unitAmount).toBe(price.amount);
      expect(row.planPriceId).toBe((await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } })).defaultPriceId);
    });

    it('repairs a free plan written with no flag, and a plan whose price row disagrees with it', async () => {
      await prisma.$executeRaw`INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "updated_at")
        VALUES ('plan_raw_free', ${w.applicationId}, 'rawfree', 'Raw free', 0, 'USD', now())`;
      const before = await prisma.plan.findUniqueOrThrow({ where: { id: 'plan_raw_free' } });
      expect(before).toMatchObject({ isFree: false, defaultPriceId: null });
      const [repaired] = await withDefaultPrices([before]);
      expect(repaired).toMatchObject({ isFree: true, defaultPrice: null });
      expect((await prisma.plan.findUniqueOrThrow({ where: { id: 'plan_raw_free' } })).isFree).toBe(true);

      const pro = await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } });
      await prisma.planPrice.update({ where: { id: pro.defaultPriceId! }, data: { amount: 1 } });
      const [inStep] = await withDefaultPrices([await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } })]);
      expect(inStep!.defaultPrice).toMatchObject({ amount: 2000, currency: 'USD' });
    });

    it('lets a nominated free plan written with no flag be self-activated', async () => {
      await prisma.$executeRaw`INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "updated_at")
        VALUES ('plan_raw_tier', ${w.applicationId}, 'tier', 'Tier', 0, 'USD', now())`;
      const nominated = await w.operator('PATCH', '/billing-config', { defaultPlanSlug: 'tier' });
      expect(nominated.statusCode, nominated.body).toBe(200);
    });

    it('does not fail the catalogue on a plan stored with a currency that is not one, and tells the operator', async () => {
      await prisma.$executeRaw`INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "updated_at")
        VALUES ('plan_bad_ccy', ${w.applicationId}, 'badccy', 'Bad currency', 500, 'dollars', now())`;
      const items = await catalogue(w.publishableKey);
      const bad = items.find((plan) => plan.slug === 'badccy');
      expect(bad).toMatchObject({ checkout: { ready: false }, price: null, prices: [] });

      const listed = await w.operator('GET', '/plans');
      expect(listed.statusCode, listed.body).toBe(200);
      const operatorView = (listed.json().data as { items: Array<{ slug: string; checkout: { blockers: Array<{ code: string; fix: string }> } }> }).items.find(
        (plan) => plan.slug === 'badccy',
      )!;
      expect(operatorView.checkout.blockers[0]).toMatchObject({ code: 'PLAN_CURRENCY_INVALID' });
      expect(operatorView.checkout.blockers[0]!.fix).toContain('/plans/badccy');

      const bought = await w.checkout({ planSlug: 'badccy' });
      expect(bought.statusCode, bought.body).toBe(409);
      expect(bought.json().error.code).toBe('PLAN_CURRENCY_INVALID');
      expect(await prisma.checkoutSession.count()).toBe(0);

      // A write that is not about the price leaves it alone too, and makes no price row for it.
      const renamed = await w.operator('PATCH', '/plans/badccy', { name: 'Still bad' });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(await prisma.planPrice.count({ where: { planId: 'plan_bad_ccy' } })).toBe(0);

      // The repair the blocker names works.
      const fixed = await w.operator('PATCH', '/plans/badccy', { price: { currency: 'USD', amount: 500 } });
      expect(fixed.statusCode, fixed.body).toBe(200);
      expect((await catalogue(w.publishableKey)).find((plan) => plan.slug === 'badccy')).toMatchObject({ price: { currency: 'USD', amount: 500 } });
    });
  });

  describe('what a checkout and a payment record', () => {
    it('writes the session charge and discount, and the payment price, provider and verification', async () => {
      const coupon = await w.operator('POST', '/coupons', { code: 'TENPCT', discountType: 'PERCENT', basisPoints: 1000 });
      expect(coupon.statusCode, coupon.body).toBe(201);
      await w.createPlan({ slug: 'pack', name: 'Pack', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 10 });
      const { row } = await w.sessionOf(await w.checkout({ planSlug: 'pack', couponCode: 'TENPCT' }));
      expect(row).toMatchObject({ unitAmount: 1000, discountAmount: 100, chargeAmount: 900 });

      const plain = await w.sessionOf(await w.checkout({}, { buyer: await w.newBuyer() }));
      expect(plain.row).toMatchObject({ unitAmount: 2000, discountAmount: 0, chargeAmount: 2000 });
    });

    it('states on a recorded payment which price it paid, through which provider, and that it was verified', async () => {
      const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
      await w.razorpayWebhook({
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: row.providerSessionId, status: 'active' } } },
      });
      const charged = await w.razorpayWebhook({
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: row.providerSessionId, status: 'active', paid_count: 2 } },
          payment: { entity: { id: 'pay_renewal_1', amount: 149900, currency: 'INR' } },
        },
      });
      expect(charged.statusCode, charged.body).toBe(200);
      expect(await prisma.payment.findFirstOrThrow({ where: { providerPaymentId: 'pay_renewal_1' } })).toMatchObject({
        status: 'SUCCEEDED',
        amount: 149900,
        currency: 'INR',
        provider: 'razorpay',
        verification: 'VERIFIED',
        planPriceId: w.inrPriceId,
        unitAmount: 149900,
      });
    });
  });

  describe('a percentage coupon on a currency charged in whole units', () => {
    it.each([
      ['HUF', paypalWire],
      ['MGA', stripeWire],
      ['TWD', paypalWire],
    ] as const)('quotes and charges a %s discount every provider can take, the same on the page and at checkout', async (currency, toWire) => {
      await prisma.billingCredentials.updateMany({ where: { applicationId: w.applicationId, provider: 'stripe' }, data: { currencies: ['USD', currency] } });
      await w.createPlan({ slug: 'local', name: 'Local', price: { currency: currency, amount: 499000 }, kind: 'CREDIT', creditsAmount: 10 });
      const coupon = await w.operator('POST', '/coupons', { code: 'PCT15', discountType: 'PERCENT', basisPoints: 1500 });
      expect(coupon.statusCode, coupon.body).toBe(201);

      // 15% is 74850, which is not a whole unit. Rounded up for the buyer: 74900.
      const preview = await w.asBuyer('POST', '/coupons/validate', { code: 'PCT15', planSlug: 'local' });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().data).toMatchObject({ currency, amount: 499000, discountAmount: 74900, amountAfterDiscount: 424100 });

      const bought = await w.checkout({ planSlug: 'local', couponCode: 'PCT15' });
      const { row } = await w.sessionOf(bought);
      expect(bought.json().data.discountAmount).toBe(74900);
      expect(row).toMatchObject({ currency, unitAmount: 499000, discountAmount: 74900, chargeAmount: 424100 });

      // What a provider is sent for the discount and for what is left: neither is refused.
      expect(() => toWire(currency, 74900)).not.toThrow();
      expect(() => toWire(currency, 424100)).not.toThrow();
      // The figure the old rounding produced is the one a provider refuses.
      expect(() => toWire(currency, 74850)).toThrow();
    });
  });

  describe('completeCheckoutSession', () => {
    it('leaves a subscription of another Application alone, whatever the session row names', async () => {
      const other = await twoCurrencyWorld(app);
      const victim = await prisma.subscription.create({
        data: { applicationId: other.applicationId, endUserId: other.buyer.id, planId: other.planId, status: 'ACTIVE' },
      });
      await prisma.checkoutSession.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          subscriptionId: victim.id,
          provider: 'stripe',
          providerSessionId: 'cs_cross_app',
          mode: 'REDIRECT',
          paymentMode: 'TEST',
          kind: 'RECURRING',
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/no',
          currency: 'USD',
          unitAmount: 1,
          expiresAt: new Date(Date.now() + 3_600_000),
          metadata: {},
        },
      });
      await markCheckoutSessionComplete(w.applicationId, 'cs_cross_app');
      expect(await prisma.subscription.findUniqueOrThrow({ where: { id: victim.id } })).toMatchObject({
        currency: null,
        unitAmount: null,
        planPriceId: null,
      });
    });
  });

  describe('a checkout completing', () => {
    it('prices the subscription in the currency the session charged, even after the plan default moved to another', async () => {
      const subscription = await prisma.subscription.create({
        data: { applicationId: w.applicationId, endUserId: w.buyer.id, planId: w.planId, status: 'PENDING' },
      });
      // A session opened at the default price when that was EUR 18.00. The default is USD now.
      await prisma.checkoutSession.create({
        data: {
          applicationId: w.applicationId,
          endUserId: w.buyer.id,
          subscriptionId: subscription.id,
          provider: 'stripe',
          providerSessionId: 'cs_eur_then',
          mode: 'REDIRECT',
          paymentMode: 'TEST',
          kind: 'RECURRING',
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/no',
          currency: 'EUR',
          unitAmount: 1800,
          expiresAt: new Date(Date.now() + 3_600_000),
          metadata: {},
        },
      });
      await markCheckoutSessionComplete(w.applicationId, 'cs_eur_then');
      const priced = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(priced).toMatchObject({ currency: 'EUR', unitAmount: 1800 });
      const row = await prisma.planPrice.findUniqueOrThrow({ where: { id: priced.planPriceId! } });
      expect(row).toMatchObject({ planId: w.planId, currency: 'EUR' });
      expect(row.archivedAt).not.toBeNull();
    });
  });

  describe("the catalogue's bound currency", () => {
    it("follows the organization a checkout would bill, not only the buyer's own subscriptions", async () => {
      const organization = await prisma.organization.create({
        data: { applicationId: w.applicationId, name: 'Acme', slug: 'acme' },
      });
      const owner = await w.newBuyer();
      await w.createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
      await w.putPrice('team', 'INR', 399900);
      const team = await prisma.plan.findFirstOrThrow({ where: { applicationId: w.applicationId, slug: 'team' } });
      const inr = await prisma.planPrice.findFirstOrThrow({ where: { planId: team.id, currency: 'INR' } });
      // The organization pays in INR through Razorpay; its owner holds the row.
      const sub = await prisma.subscription.create({
        data: {
          applicationId: w.applicationId,
          endUserId: owner.id,
          planId: team.id,
          status: 'ACTIVE',
          provider: 'razorpay',
          providerSubId: 'sub_org_inr',
          beneficiaryOrgId: organization.id,
        },
      });
      await prisma.$executeRaw`UPDATE "subscriptions" SET "currency" = 'INR', "unit_amount" = 399900, "plan_price_id" = ${inr.id} WHERE "id" = ${sub.id}`;

      const [pro] = await withDefaultPrices([await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } })]);
      const member = { buyer: null, callerIsSecretKey: false, localPrices: 'trusted' as const, endUserId: w.buyer.id };
      const personal = await resolvePlanPrices(w.applicationId, [pro!], member);
      expect(personal.get(w.planId)?.price).toMatchObject({ currency: 'USD', reason: 'default' });
      const forOrg = await resolvePlanPrices(w.applicationId, [pro!], { ...member, beneficiaryOrgId: organization.id });
      expect(forOrg.get(w.planId)?.price).toMatchObject({ currency: 'INR', amount: 149900, reason: 'bound' });
    });
  });
});
