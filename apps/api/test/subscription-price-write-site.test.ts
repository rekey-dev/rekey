/**
 * `snapshotSubscriptionPrice` held to its own contract against the database.
 * That it is the only writer of a subscription's price is held by
 * `money-source-scan.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { snapshotSubscriptionPrice } from '../src/modules/billing/subscription-snapshot.js';

describe('snapshotSubscriptionPrice', () => {
  let applicationId: string;
  let planId: string;
  let subscriptionId: string;

  async function plan(data: { amount: number; currency?: string; pricePerUnitCents?: number }): Promise<string> {
    const row = await prisma.plan.create({
      data: { applicationId, slug: `p-${randomUUID().slice(0, 8)}`, name: 'Plan', ...data },
    });
    return row.id;
  }

  async function subscribe(toPlan: string): Promise<string> {
    const user = await prisma.endUser.create({
      data: { applicationId, email: `b-${randomUUID().slice(0, 8)}@example.com`, passwordHash: 'x' },
    });
    const row = await prisma.subscription.create({ data: { applicationId, endUserId: user.id, planId: toPlan, status: 'ACTIVE' } });
    return row.id;
  }

  const read = () => prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({ data: { name: `WS ${suffix}`, ownerEmail: `op-${suffix}@example.com` } });
    const application = await prisma.application.create({
      data: {
        tenantId: tenant.id,
        name: `App ${suffix}`,
        slug: `snap-${suffix}`,
        publicKey: `rp_pub_snap-${suffix}_${randomUUID().slice(0, 12)}`,
        authConfig: { mfa: 'optional', methods: ['password'], tokenAlg: 'HS256' },
        billingConfig: {},
      },
    });
    applicationId = application.id;
    planId = await plan({ amount: 2000, currency: 'usd' });
    subscriptionId = await subscribe(planId);
  });

  it('writes the default price, creating its row for a plan that predates price rows', async () => {
    const result = await snapshotSubscriptionPrice(prisma, { subscriptionId, planPriceId: 'default' });
    const { defaultPriceId } = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(defaultPriceId).not.toBeNull();
    // The price row's currency, not the plan column's spelling of it.
    expect(result).toEqual({ written: true, price: { planPriceId: defaultPriceId, currency: 'USD', unitAmount: 2000 } });
    expect(await read()).toMatchObject({ planPriceId: defaultPriceId, currency: 'USD', unitAmount: 2000 });
    expect(await prisma.planPrice.findUniqueOrThrow({ where: { id: defaultPriceId! } })).toMatchObject({ currency: 'USD', amount: 2000 });
  });

  it('writes a named price at its own amount, or at a negotiated one', async () => {
    const inr = await prisma.planPrice.create({ data: { applicationId, planId, currency: 'INR', amount: 149900 } });
    await snapshotSubscriptionPrice(prisma, { subscriptionId, planPriceId: inr.id });
    expect(await read()).toMatchObject({ planPriceId: inr.id, currency: 'INR', unitAmount: 149900 });
    await snapshotSubscriptionPrice(prisma, { subscriptionId, planPriceId: inr.id, unitAmountOverride: 99900 });
    expect(await read()).toMatchObject({ planPriceId: inr.id, currency: 'INR', unitAmount: 99900 });
  });

  it('refuses a price that belongs to another plan', async () => {
    const other = await plan({ amount: 500 });
    const foreign = await prisma.planPrice.create({ data: { applicationId, planId: other, currency: 'EUR', amount: 400 } });
    await expect(snapshotSubscriptionPrice(prisma, { subscriptionId, planPriceId: foreign.id })).rejects.toMatchObject({
      code: 'BILLING_PLAN_PRICE_NOT_FOUND',
      fix: expect.stringContaining('prices'),
    });
    expect(await read()).toMatchObject({ planPriceId: null, currency: null, unitAmount: null });
  });

  it('writes nothing for a plan with no flat price', async () => {
    for (const free of [await plan({ amount: 0 }), await plan({ amount: 0, pricePerUnitCents: 5 })]) {
      subscriptionId = await subscribe(free);
      const result = await snapshotSubscriptionPrice(prisma, {
        subscriptionId,
        planPriceId: 'default',
        unitAmountOverride: 0,
        chargedCurrency: 'USD',
      });
      expect(result).toEqual({ written: false, price: null });
      expect(await read()).toMatchObject({ planPriceId: null, currency: null, unitAmount: null });
    }
  });

  it('keeps an existing price when asked to write only an unpriced row', async () => {
    const inr = await prisma.planPrice.create({ data: { applicationId, planId, currency: 'INR', amount: 149900 } });
    const first = await snapshotSubscriptionPrice(prisma, { subscriptionId, planPriceId: inr.id, onlyIfUnpriced: true });
    expect(first.written).toBe(true);
    const second = await snapshotSubscriptionPrice(prisma, { subscriptionId, planPriceId: 'default', onlyIfUnpriced: true });
    expect(second).toEqual({ written: false, price: null });
    expect(await read()).toMatchObject({ planPriceId: inr.id, currency: 'INR' });
  });

  it('names an archived price when the money was taken in a currency the plan has since left', async () => {
    const result = await snapshotSubscriptionPrice(prisma, {
      subscriptionId,
      planPriceId: 'default',
      unitAmountOverride: 1800,
      chargedCurrency: 'EUR',
    });
    expect(result.price).toMatchObject({ currency: 'EUR', unitAmount: 1800 });
    const archived = await prisma.planPrice.findUniqueOrThrow({ where: { id: result.price!.planPriceId } });
    expect(archived).toMatchObject({ planId, currency: 'EUR', amount: 1800 });
    expect(archived.archivedAt).not.toBeNull();
    // An archived price is not on sale: the plan still has one live price, its default.
    expect(await prisma.planPrice.count({ where: { planId, archivedAt: null } })).toBe(1);
  });

  it('refuses an amount that is not a whole, non-negative number of minor units', async () => {
    for (const unitAmountOverride of [-1, 19.99, Number.NaN]) {
      await expect(
        snapshotSubscriptionPrice(prisma, { subscriptionId, planPriceId: 'default', unitAmountOverride }),
      ).rejects.toMatchObject({ code: 'BILLING_UNIT_AMOUNT_INVALID' });
    }
  });

  it('joins the transaction it is given: a rollback takes the price with it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await snapshotSubscriptionPrice(tx, { subscriptionId, planPriceId: 'default' });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await read()).toMatchObject({ planPriceId: null, currency: null, unitAmount: null });
  });
});
