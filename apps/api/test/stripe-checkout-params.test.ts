/**
 * What `RealStripeProvider` asks Stripe for, with the SDK stubbed.
 *
 * Checkout must not pin `payment_method_types`: a pinned `['card']` hides Link
 * and every method the operator enabled in their Stripe account. And a webhook
 * endpoint Rekey registers must pin the API version its client speaks, or its
 * events arrive in the account's default version, whose shapes can differ.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndUser, Plan } from '@prisma/client';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import type { CheckoutSessionInput } from '../src/modules/billing/providers/types.js';

const spy = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  endpoints: [] as Record<string, unknown>[],
}));

vi.mock('stripe', () => {
  class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          spy.sessions.push(params);
          return { id: 'cs_fake', url: 'https://checkout.stripe.test/cs_fake' };
        },
      },
    };
    webhookEndpoints = {
      list: async () => ({ data: [] }),
      del: async () => ({}),
      create: async (params: Record<string, unknown>) => {
        spy.endpoints.push(params);
        return { id: 'we_fake', secret: 'whsec_fake' };
      },
    };
  }
  return { default: FakeStripe };
});

function input(): CheckoutSessionInput {
  return {
    application: { id: 'app_1', slug: 'app' },
    endUser: { id: 'eu_1', email: 'buyer@example.com' } as unknown as EndUser,
    plan: {
      id: 'pl_1',
      applicationId: 'app_1',
      slug: 'pro',
      name: 'Pro',
      amount: 5000,
      currency: 'USD',
      interval: 'MONTH',
      metadata: { stripe: { priceId: 'price_fake' } },
    } as unknown as Plan,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
  };
}

const provider = (): RealStripeProvider =>
  new RealStripeProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x' });

describe('Stripe checkout offers the account’s payment methods', () => {
  beforeEach(() => {
    spy.sessions.length = 0;
  });

  it('a subscription session does not pin payment_method_types', async () => {
    await provider().createCheckoutSession(input());
    expect(spy.sessions).toHaveLength(1);
    expect(spy.sessions[0]).toMatchObject({ mode: 'subscription', line_items: [{ price: 'price_fake', quantity: 1 }] });
    expect(spy.sessions[0]).not.toHaveProperty('payment_method_types');
  });

  it('a one-time session does not pin payment_method_types', async () => {
    await provider().createOneTimeCheckout(input());
    expect(spy.sessions).toHaveLength(1);
    expect(spy.sessions[0]).toMatchObject({ mode: 'payment' });
    expect(spy.sessions[0]).not.toHaveProperty('payment_method_types');
  });
});

describe('Stripe webhook registration', () => {
  beforeEach(() => {
    spy.endpoints.length = 0;
  });

  it('pins the endpoint to the client’s API version and subscribes async payment success', async () => {
    const result = await provider().registerWebhook('https://api.example/api/v1/billing/webhook/stripe/app');
    expect(result).toEqual({ webhookId: 'we_fake', secret: 'whsec_fake' });
    expect(spy.endpoints).toHaveLength(1);
    expect(spy.endpoints[0]).toMatchObject({ api_version: STRIPE_API_VERSION });
    expect(STRIPE_API_VERSION).toBe('2024-11-20.acacia');
    expect(spy.endpoints[0]!.enabled_events).toEqual(
      expect.arrayContaining(['checkout.session.completed', 'checkout.session.async_payment_succeeded']),
    );
  });
});
