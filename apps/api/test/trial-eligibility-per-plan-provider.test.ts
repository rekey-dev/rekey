/**
 * `GET /billing/trial-eligibility` judges each plan against the provider its
 * own checkout would go to.
 *
 * Stripe (USD only) runs trials and Razorpay (INR only, India) does not. One
 * provider for the whole catalogue gets a plan wrong whenever the country's
 * default is not the provider that plan is charged through.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface Item {
  planSlug: string;
  eligible: boolean;
  reason: string | null;
  provider?: string;
}

describe('trial eligibility per plan provider', () => {
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
    // `usd-only` is sold in dollars alone; `local` also has a rupee price.
    await w.createPlan({ slug: 'usd-only', name: 'USD only', price: { currency: 'USD', amount: 3000 }, trialDays: 14 });
    await w.createPlan({ slug: 'local', name: 'Local', price: { currency: 'USD', amount: 4000 }, trialDays: 14 });
    await w.putPrice('local', 'INR', 299900);
    await w.createPlan({ slug: 'pack', name: 'Pack', price: { currency: 'USD', amount: 1000 }, kind: 'CREDIT', creditsAmount: 10 });
  });

  async function eligibility(query = '', opts: { key?: string; buyer?: Buyer } = {}) {
    const res = await w.asBuyer('GET', `/trial-eligibility${query}`, undefined, opts);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { provider: string; items: Item[] };
    return { provider: data.provider, of: (slug: string) => data.items.find((i) => i.planSlug === slug)! };
  }

  it('offers the trial on a plan charged through Stripe although the country default is Razorpay', async () => {
    const { provider, of } = await eligibility('?country=IN');
    // The default for India, kept as it was for callers that read it.
    expect(provider).toBe('razorpay');
    // No rupee price, so the checkout is in dollars and goes to Stripe.
    expect(of('usd-only')).toMatchObject({ eligible: true, reason: null, provider: 'stripe' });
    // Its rupee price applies in India, and Razorpay cannot run the trial.
    expect(of('local')).toMatchObject({
      eligible: false,
      reason: 'PLAN_TRIAL_MISCONFIGURED',
      provider: 'razorpay',
    });
  });

  it('agrees with the checkout each answer predicts', async () => {
    const { of } = await eligibility('?country=IN');
    const usdOnly = await w.sessionOf(await w.checkout({ planSlug: 'usd-only', country: 'IN' }));
    expect(usdOnly.provider).toBe(of('usd-only').provider);
    const local = await w.checkout({ planSlug: 'local', country: 'IN' }, { buyer: await w.newBuyer() });
    expect(local.statusCode).toBe(400);
  });

  it('does not believe a country a browser states, exactly as checkout does not', async () => {
    const { of } = await eligibility('?country=IN', { key: w.publishableKey });
    expect(of('local')).toMatchObject({ eligible: true, provider: 'stripe' });
  });

  it('names a provider only where the answer depends on one', async () => {
    const { of } = await eligibility('?country=IN');
    expect(of('pro')).toMatchObject({ reason: 'PLAN_HAS_NO_TRIAL' });
    expect(of('pro')).not.toHaveProperty('provider');
    expect(of('pack')).not.toHaveProperty('provider');
  });

  it('judges one plan the same way the catalogue does', async () => {
    const one = await eligibility('?planSlug=local&country=IN');
    expect(one.of('local')).toMatchObject({ reason: 'PLAN_TRIAL_MISCONFIGURED', provider: 'razorpay' });
    const other = await eligibility('?planSlug=usd-only&country=IN');
    expect(other.of('usd-only')).toMatchObject({ eligible: true, provider: 'stripe' });
  });

  it('follows the provider a subscriber already pays through', async () => {
    const first = await w.sessionOf(await w.checkout({ country: 'IN' }));
    await w.razorpayWebhook({
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: first.row.providerSessionId, status: 'active' } } },
    });
    // No country given: a new buyer would get Stripe, this one is bound to Razorpay and INR.
    const { of } = await eligibility();
    expect(of('local')).toMatchObject({ reason: 'PLAN_TRIAL_MISCONFIGURED', provider: 'razorpay' });
  });
});
