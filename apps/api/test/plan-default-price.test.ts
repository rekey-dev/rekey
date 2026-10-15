/**
 * The rules a plan's default price holds on create and on PATCH.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('plan default price', () => {
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

  });

});
