/**
 * Provider adapters charge the price a checkout selected: the amount, the
 * currency and the provider id all come from the `PricedPlan`, and an
 * additional price never borrows the default price's registration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndUser, PlanPrice } from '@prisma/client';
import { hasAnyRegistration, providerRegistration } from '../src/modules/billing/priced-plan.js';
import { pricedPlanFixture as pricedPlan, type FixturePlan } from './priced-plan-fixture.js';
import { RealPaypalProvider } from '../src/modules/billing/providers/paypal.js';
import { paymentPurchase, stripePriceIdFor } from '../src/modules/billing/providers/stripe-session-params.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const plan = {
  id: 'plan_1',
  slug: 'pro',
  name: 'Pro',
  applicationId: 'app_1',
  amount: 2000,
  currency: 'USD',
  interval: 'MONTH',
  metadata: { stripe: { priceId: 'price_usd' }, paypal: { planId: 'P-USD' }, razorpay: { planId: 'plan_usd' }, note: 'x' },
} as unknown as FixturePlan;

function inrPrice(metadata: Record<string, unknown> = {}): PlanPrice {
  return { id: 'pp_inr', currency: 'INR', amount: 149900, metadata } as unknown as PlanPrice;
}

const endUser = { id: 'eu_1', email: 'buyer@example.com' } as unknown as EndUser;

function checkoutInput(priced: ReturnType<typeof pricedPlan>) {
  return {
    application: { id: 'app_1', slug: 'acme' },
    endUser,
    plan: priced,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
  };
}

describe('pricedPlan', () => {
  it('is the plan at its default price row, with that row’s registration', () => {
    const priced = pricedPlan(plan, null);
    expect(priced).toMatchObject({ amount: 2000, currency: 'USD', planPriceId: 'pp_default_plan_1', isDefaultPrice: true });
    expect(providerRegistration(priced, 'stripe')).toEqual({ priceId: 'price_usd' });
    expect(providerRegistration(priced, 'razorpay')).toEqual({ planId: 'plan_usd' });
  });

  it('carries an additional price and only that price’s registration', () => {
    const priced = pricedPlan(plan, inrPrice({ razorpay: { planId: 'plan_inr', mode: 'test' } }));
    expect(priced).toMatchObject({ id: 'plan_1', slug: 'pro', amount: 149900, currency: 'INR', planPriceId: 'pp_inr' });
    expect(providerRegistration(priced, 'razorpay')).toEqual({ planId: 'plan_inr', mode: 'test' });
    expect(providerRegistration(priced, 'stripe')).toEqual({});
    expect(providerRegistration(priced, 'paypal')).toEqual({});
  });

  it('counts only provider ids as a registration', () => {
    expect(hasAnyRegistration({})).toBe(false);
    expect(hasAnyRegistration({ razorpay: {} })).toBe(false);
    expect(hasAnyRegistration({ razorpay: { mode: 'test' } })).toBe(false);
    expect(hasAnyRegistration({ razorpay: { planId: 'plan_inr' } })).toBe(true);
    expect(hasAnyRegistration({ stripe: { priceId: 'price_inr' } })).toBe(true);
  });
});

describe('Stripe', () => {
  it('charges the additional price’s own Stripe price', () => {
    const priced = pricedPlan(plan, inrPrice({ stripe: { priceId: 'price_inr', mode: 'test' } }));
    expect(stripePriceIdFor(checkoutInput(priced))).toBe('price_inr');
  });

  it('never falls back to the default price’s Stripe price for an unregistered additional price', () => {
    expect(() => stripePriceIdFor(checkoutInput(pricedPlan(plan, inrPrice())))).toThrow(/not registered/);
  });

  it('prices a one-time purchase at the selected amount and currency', () => {
    const params = paymentPurchase(checkoutInput(pricedPlan(plan, inrPrice())), undefined);
    expect(params.line_items![0]!.price_data).toMatchObject({ currency: 'inr', unit_amount: 149900 });
  });
});

describe('PayPal', () => {
  afterEach(() => vi.restoreAllMocks());

  function stubPaypal() {
    const calls: Array<{ url: string; requestId: string | null; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      calls.push({
        url,
        requestId: new Headers(init?.headers).get('PayPal-Request-Id'),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      if (url.endsWith('/v1/billing/plans')) return Response.json({ id: 'P-NEW' });
      if (url.endsWith('/v1/billing/subscriptions')) {
        return Response.json({ id: 'I-NEW', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }] });
      }
      return Response.json({});
    });
    return calls;
  }

  const provider = () => new RealPaypalProvider({ clientId: 'c', clientSecret: 's', webhookId: 'WH-1' }, 'test');

  it('registers an additional price under a request id of its own, in its currency', async () => {
    const calls = stubPaypal();
    const ref = await provider().ensurePlanRegistered(pricedPlan(plan, inrPrice()));
    expect(ref).toEqual({ providerPlanId: 'P-NEW' });
    const created = calls.find((c) => c.url.endsWith('/v1/billing/plans'))!;
    expect(created.requestId).toMatch(/^REKEY-PRICE-[^-]+-\d+$/);
    expect(JSON.stringify(created.body)).toContain('"fixed_price":{"value":"1499.00","currency_code":"INR"}');
  });

  it('keeps the request id the default price has always had', async () => {
    const calls = stubPaypal();
    await provider().ensurePlanRegistered(pricedPlan(plan, null));
    expect(calls.find((c) => c.url.endsWith('/v1/billing/plans'))!.requestId).toBe('REKEY-PLAN-plan_1');
  });

  it('subscribes the buyer to the additional price’s PayPal plan, not the default one', async () => {
    const calls = stubPaypal();
    const priced = pricedPlan(plan, inrPrice({ paypal: { planId: 'P-INR', mode: 'test' } }));
    await provider().createCheckoutSession(checkoutInput(priced));
    expect(calls.some((c) => c.url.endsWith('/v1/billing/plans'))).toBe(false);
    expect(calls.find((c) => c.url.endsWith('/v1/billing/subscriptions'))!.body.plan_id).toBe('P-INR');
  });
});
