/**
 * GET /billing/plans for a signed-in buyer: one whose provider can no longer
 * charge their currency sees the price they are bound to and that they cannot
 * check out, and the read costs the same queries however many plans exist.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { countQueries } from './query-counter.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

type CataloguePlan = {
  slug: string;
  checkout: { ready: boolean };
  price: { currency: string; amount: number; reason: string } | null;
};

describe('the plan catalogue for a signed-in buyer', () => {
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

  /** Put `buyer` on `pro` in INR through Razorpay, as a completed checkout would. */
  const subscribeInInr = async (buyer: Buyer): Promise<void> => {
    const sub = await prisma.subscription.create({
      data: {
        applicationId: w.applicationId,
        endUserId: buyer.id,
        planId: w.planId,
        status: 'ACTIVE',
        provider: 'razorpay',
        providerSubId: `sub_inr_${buyer.id}`,
      },
    });
    await prisma.$executeRaw`UPDATE "subscriptions" SET "currency" = 'INR', "unit_amount" = 149900, "plan_price_id" = ${w.inrPriceId} WHERE "id" = ${sub.id}`;
  };

  const razorpayCharges = (currencies: string[]) =>
    billingCredentialsService.upsertRaw(
      w.applicationId,
      'razorpay',
      { keyId: 'rzp_test_ci', keySecret: 'secret_ci_only', webhookSecret: 'rzp_whsec_two_currency' },
      { mode: 'test', enabled: true, currencies, countries: ['IN'], priority: 50 },
    );
  describe('GET /billing/plans for a buyer whose provider can no longer charge their currency', () => {
    const catalogue = async (opts: { key?: string; buyer?: Buyer } = {}): Promise<CataloguePlan[]> => {
      const res = await w.asBuyer('GET', '/plans', undefined, opts);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().data as { items: CataloguePlan[] }).items;
    };

    beforeEach(async () => {
      await w.createPlan({ slug: 'team', name: 'Team', price: { currency: 'USD', amount: 5000 } });
      await w.putPrice('team', 'INR', 399900);
      await subscribeInInr(w.buyer);
      await razorpayCharges(['USD']);
    });

    it('answers with the price they are bound to and says they cannot check out', async () => {
      for (const key of [w.secretKey, w.publishableKey]) {
        const plans = await catalogue({ key });
        expect(plans.find((plan) => plan.slug === 'team')).toMatchObject({
          checkout: { ready: false },
          price: { currency: 'INR', amount: 399900, reason: 'bound' },
        });
        expect(plans.find((plan) => plan.slug === 'pro')).toMatchObject({
          checkout: { ready: false },
          price: { currency: 'INR', amount: 149900, reason: 'bound' },
        });
      }
    });

    it('still refuses their checkout', async () => {
      const res = await w.checkout({ planSlug: 'team' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('BILLING_CURRENCY_CONFLICT');
      expect(res.json().error.message).toContain('"razorpay", the provider they pay through, is no longer set up to charge INR.');
    });
  });

  describe('GET /billing/plans for a signed-in buyer', () => {
    it('costs the same number of queries for seven recurring plans as for two', async () => {
      await subscribeInInr(w.buyer);
      const measure = async (): Promise<number> => {
        await w.asBuyer('GET', '/plans?limit=50');
        const counted = await countQueries(async () => {
          const res = await w.asBuyer('GET', '/plans?limit=50');
          expect(res.statusCode, res.body).toBe(200);
        });
        return counted.count;
      };
      const addPlans = async (from: number, to: number): Promise<void> => {
        for (let i = from; i < to; i += 1) {
          await w.createPlan({ slug: `p${i}`, name: `Plan ${i}`, price: { currency: 'USD', amount: 3000 + i } });
          await w.putPrice(`p${i}`, 'INR', 250000 + i);
        }
      };
      await addPlans(0, 1);
      const two = await measure();
      await addPlans(1, 6);
      const seven = await measure();
      expect(seven).toBe(two);
    });
  });
});
