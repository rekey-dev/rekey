/**
 * The real PayPal provider's embedded-checkout calls, with PayPal's REST API
 * stubbed at `fetch`: which base each mode reaches, what the subscription is
 * created with, and how a subscription is read back for confirmation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndUser, Plan } from '@prisma/client';
import { RealPaypalProvider } from '../src/modules/billing/providers/paypal.js';
import { getModule } from '../src/modules/billing/providers/registry.js';

const creds = { clientId: 'AbC-client', clientSecret: 'shh', webhookId: 'WH-1' };
const plan = {
  id: 'plan_1',
  slug: 'standard',
  name: 'Cloud Standard',
  applicationId: 'app_1',
  amount: 9900,
  currency: 'USD',
  interval: 'MONTH',
  metadata: { paypal: { planId: 'P-STANDARD' } },
} as unknown as Plan;
const endUser = { id: 'eu_1', email: 'buyer@example.com' } as unknown as EndUser;

type Call = { url: string; init: RequestInit | undefined };

function stubPaypal(subscription: Record<string, unknown> | null = null): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/v1/billing/subscriptions') && init?.method === 'POST') {
      return Response.json({ id: 'I-NEW123', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?ba_token=BA-1' }] });
    }
    if (url.includes('/v1/billing/subscriptions/')) {
      return subscription === null ? new Response('{}', { status: 404 }) : Response.json(subscription);
    }
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

const input = {
  application: { id: 'app_1', slug: 'acme' },
  endUser,
  plan,
  successUrl: 'https://app.example/ok',
  cancelUrl: 'https://app.example/cancel',
  kind: 'recurring' as const,
  returnUrl: 'https://portal.example/acme/checkout/chk_test_x',
};

describe('RealPaypalProvider, embedded checkout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates the subscription on the sandbox base in test mode, returning buyers to the Rekey page', async () => {
    const calls = stubPaypal();
    const result = await new RealPaypalProvider(creds, 'test').createEmbeddedCheckout(input);
    const create = calls.find((c) => c.url.endsWith('/v1/billing/subscriptions'))!;
    expect(create.url).toBe('https://api-m.sandbox.paypal.com/v1/billing/subscriptions');
    const body = JSON.parse(String(create.init?.body)) as {
      plan_id: string;
      custom_id: string;
      application_context: { return_url: string; cancel_url: string };
    };
    expect(body.plan_id).toBe('P-STANDARD');
    expect(body.custom_id).toBe('app_1:eu_1');
    expect(body.application_context.return_url).toBe(input.returnUrl);
    expect(body.application_context.cancel_url).toBe(input.returnUrl);
    expect(result).toEqual({
      sessionId: 'I-NEW123',
      client: { provider: 'paypal', clientId: 'AbC-client', subscriptionId: 'I-NEW123', sdk: 'v5-subscription' },
      fallbackUrl: 'https://www.sandbox.paypal.com/checkoutnow?ba_token=BA-1',
      providerPlanId: 'P-STANDARD',
    });
    expect(JSON.stringify(result)).not.toContain('shh');
  });

  it('uses the live base in live mode, for creating and for reading back', async () => {
    const calls = stubPaypal({ id: 'I-NEW123', status: 'APPROVED', plan_id: 'P-STANDARD', custom_id: 'app_1:eu_1' });
    const provider = new RealPaypalProvider(creds, 'live');
    await provider.createEmbeddedCheckout(input);
    const snapshot = await provider.getSubscription('I-NEW123');
    expect(calls.every((c) => c.url.startsWith('https://api-m.paypal.com/'))).toBe(true);
    expect(snapshot).toEqual({ id: 'I-NEW123', status: 'APPROVED', planId: 'P-STANDARD', customId: 'app_1:eu_1' });
  });

  it('reads an unknown subscription as null and encodes the id into the path', async () => {
    const calls = stubPaypal(null);
    expect(await new RealPaypalProvider(creds, 'test').getSubscription('I-1/../x')).toBeNull();
    expect(calls.at(-1)!.url).toBe('https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-1%2F..%2Fx');
  });

  it('refuses a discount and a one-time purchase', async () => {
    stubPaypal();
    const provider = new RealPaypalProvider(creds, 'test');
    await expect(
      provider.createEmbeddedCheckout({ ...input, discount: { amount: 100, currency: 'USD', couponId: 'c', code: 'x' } }),
    ).rejects.toMatchObject({ code: 'BILLING_DISCOUNT_UNSUPPORTED' });
    await expect(provider.createEmbeddedCheckout({ ...input, kind: 'one_time' })).rejects.toMatchObject({
      code: 'CHECKOUT_EMBEDDED_UNSUPPORTED',
    });
  });

  it('declares embedded checkout only with the methods and browser origins it needs', () => {
    const paypal = getModule('paypal')!;
    expect(paypal.capabilities.embeddedCheckout).toEqual({ recurring: true, oneTime: false });
    expect(typeof RealPaypalProvider.prototype.createEmbeddedCheckout).toBe('function');
    expect(typeof RealPaypalProvider.prototype.getSubscription).toBe('function');
    expect(paypal.browser?.test.scriptSrc).toContain('https://www.sandbox.paypal.com');
    expect(paypal.browser?.live.scriptSrc.join(' ')).not.toContain('sandbox');
  });
});
