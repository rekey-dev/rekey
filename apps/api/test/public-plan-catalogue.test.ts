/**
 * What the plan catalogue returns: the pinned field set a publishable key
 * sees, the extra fields an operator sees, and the currency a buyer is bound
 * to.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resolvePlanPrices } from '../src/modules/billing/checkout-price-resolution.js';

import { withDefaultPrices } from '../src/modules/plans/default-price.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('the plan catalogue', () => {
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
