/**
 * What an operator is shown a subscription costs is the subscription's own
 * price, not its plan's default: the end-user billing view, the data export
 * and the MCP subscription rows. A subscription with no price of its own shows
 * none. And a price label is formatted in the currency's own minor unit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import { allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { priceLabel } from '../src/modules/billing/price-label.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface PricedRow {
  price: { amount: number; currency: string } | null;
  plan: Record<string, unknown>;
}

describe('readers of what a subscription costs', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;
  let grantedTo: string;
  let unpriced: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
    // One buyer paid the INR price; another was granted the plan and has no price of their own.
    const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
    await w.razorpayWebhook({
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: row.providerSessionId, status: 'active' } } },
    });
    grantedTo = (await w.newBuyer()).id;
    const grant = await w.operator('POST', `/end-users/${grantedTo}/subscriptions`, { planSlug: 'pro' });
    expect(grant.statusCode, grant.body).toBe(201);
    // A third is on the plan with no price recorded, as an older row or an unpaid external activation is.
    unpriced = (await w.newBuyer()).id;
    await prisma.subscription.create({
      data: { applicationId: w.applicationId, endUserId: unpriced, planId: w.planId, status: 'ACTIVE', provider: 'external' },
    });
  });

  it('the operator billing view reports the subscription price beside the plan', async () => {
    const paid = await w.operator('GET', `/end-users/${w.buyer.id}/billing`);
    expect(paid.statusCode, paid.body).toBe(200);
    const [sub] = (paid.json().data as { subscriptions: PricedRow[] }).subscriptions;
    expect(sub).toMatchObject({ price: { amount: 149900, currency: 'INR' } });
    // The plan's default price is not the subscriber's price, and is not sent beside it.
    expect(sub!.plan).toEqual({ slug: 'pro', name: 'Pro', kind: 'SUBSCRIPTION', interval: 'MONTH' });
    // The raw columns are not a second, competing spelling of the same fact.
    expect(sub).not.toHaveProperty('unitAmount');

    const granted = await w.operator('GET', `/end-users/${grantedTo}/billing`);
    expect((granted.json().data as { subscriptions: PricedRow[] }).subscriptions[0]!.price).toEqual({
      amount: 2000,
      currency: 'USD',
    });

    const bare = await w.operator('GET', `/end-users/${unpriced}/billing`);
    expect(bare.statusCode, bare.body).toBe(200);
    expect((bare.json().data as { subscriptions: PricedRow[] }).subscriptions[0]).toMatchObject({ price: null });
  });

  it('the data export reports the subscription price', async () => {
    const res = await w.operator('GET', `/end-users/${w.buyer.id}/export`);
    expect(res.statusCode, res.body).toBe(200);
    const [sub] = (res.json() as { subscriptions: PricedRow[] }).subscriptions;
    expect(sub).toMatchObject({ price: { amount: 149900, currency: 'INR' } });
    expect(sub!.plan).not.toHaveProperty('amount');
    expect(sub!.plan).not.toHaveProperty('currency');
    const granted = await w.operator('GET', `/end-users/${grantedTo}/export`);
    expect((granted.json() as { subscriptions: PricedRow[] }).subscriptions[0]!.price).toEqual({
      amount: 2000,
      currency: 'USD',
    });
    const bare = await w.operator('GET', `/end-users/${unpriced}/export`);
    expect((bare.json() as { subscriptions: PricedRow[] }).subscriptions[0]!.price).toBeNull();
  });

  it('the MCP subscription rows report the subscription price', async () => {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
    const owner = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantId: application.tenantId, role: 'OWNER' },
    });
    const ctx: OperatorToolContext = {
      tenantUserId: owner.tenantUserId,
      tenantId: application.tenantId,
      role: 'OWNER',
      tenantMembershipId: owner.id,
      scopes: UNRESTRICTED,
      canWrite: false,
      canAdmin: false,
    };
    const tool = allOperatorTools.find((t) => t.name === 'recent_subscriptions')!;
    const { subscriptions } = (await tool.handler(ctx, {})) as {
      subscriptions: Array<{ endUserId: string; price: { currency: string; amount: number } | null }>;
    };
    const of = (endUserId: string) => subscriptions.find((s) => s.endUserId === endUserId);
    expect(of(w.buyer.id)!.price).toEqual({ currency: 'INR', amount: 149900 });
    expect(of(grantedTo)!.price).toEqual({ currency: 'USD', amount: 2000 });
    expect(of(unpriced)!.price).toBeNull();
    expect(of(unpriced)).not.toHaveProperty('amountMinor');
    expect(of(unpriced)).not.toHaveProperty('currency');
  });
});

describe('priceLabel', () => {
  it("divides by the currency's own minor unit", () => {
    expect(priceLabel({ amount: 9900, currency: 'USD' })).toBe('$99.00');
    expect(priceLabel({ amount: 149900, currency: 'inr' })).toBe('₹1,499.00');
    // Yen has no minor unit: 1500 is 1,500 yen, not 15.
    expect(priceLabel({ amount: 1500, currency: 'JPY' })).toBe('¥1,500');
    // Intl separates a code it has no symbol for with a no-break space.
    expect(priceLabel({ amount: 12345, currency: 'KWD' })).toMatch(/^KWD\s12\.345$/);
  });

  it('names nothing for a free or unpriced plan, and survives a code it does not know', () => {
    expect(priceLabel({ amount: 0, currency: 'USD' })).toBeNull();
    expect(priceLabel({ amount: null, currency: 'USD' })).toBeNull();
    // An amount in no currency is not a price anybody can be told.
    expect(priceLabel({ amount: 9900, currency: null })).toBeNull();
    expect(priceLabel({ amount: 9900, currency: 'not-a-code' })).toBe('99.00 NOT-A-CODE');
  });
});
