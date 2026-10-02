/**
 * The real PayPal provider's embedded-checkout calls, with PayPal's REST API
 * stubbed at `fetch`: which base each mode reaches, what the subscription is
 * created with, and how a subscription or order is read back for confirmation.
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

function stubPaypal(subscription: Record<string, unknown> | null = null, order: Record<string, unknown> | null = null): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/v2/checkout/orders') && init?.method === 'POST') {
      return Response.json({ id: 'ORDER-NEW1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-NEW1' }] });
    }
    if (url.includes('/v2/checkout/orders/')) {
      return order === null ? new Response('{}', { status: 404 }) : Response.json(order);
    }
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

  it('refuses a discount on a subscription', async () => {
    stubPaypal();
    const provider = new RealPaypalProvider(creds, 'test');
    await expect(
      provider.createEmbeddedCheckout({ ...input, discount: { amount: 100, currency: 'USD', couponId: 'c', code: 'x' } }),
    ).rejects.toMatchObject({ code: 'BILLING_DISCOUNT_UNSUPPORTED' });
  });

  it('creates a one-time order exactly as the redirect does, returning buyers to the Rekey page', async () => {
    const calls = stubPaypal();
    const provider = new RealPaypalProvider(creds, 'test');
    const discount = { amount: 900, currency: 'USD', couponId: 'c', code: 'TENOFF' };
    const result = await provider.createEmbeddedCheckout({ ...input, kind: 'one_time', discount });
    const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(create.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    const body = JSON.parse(String(create.init?.body)) as {
      intent: string;
      purchase_units: Array<{ custom_id: string; amount: { currency_code: string; value: string } }>;
      application_context: { return_url: string; cancel_url: string };
    };
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units).toHaveLength(1);
    expect(body.purchase_units[0]!.custom_id).toBe('app_1:eu_1');
    expect(body.purchase_units[0]!.amount).toMatchObject({ currency_code: 'USD', value: '90.00' });
    expect(body.application_context.return_url).toBe(input.returnUrl);
    expect(body.application_context.cancel_url).toBe(input.returnUrl);
    expect(result).toEqual({
      sessionId: 'ORDER-NEW1',
      client: { provider: 'paypal', clientId: 'AbC-client', orderId: 'ORDER-NEW1', sdk: 'v5-order', currency: 'USD' },
      fallbackUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-NEW1',
      providerPlanId: null,
    });
    expect(JSON.stringify(result)).not.toContain('shh');

    const redirect = stubPaypal();
    await provider.createOneTimeCheckout({ ...input, discount });
    const redirectBody = JSON.parse(String(redirect.find((c) => c.url.endsWith('/v2/checkout/orders'))!.init?.body)) as typeof body;
    expect(redirectBody.application_context.return_url).toBe(input.successUrl);
    expect(redirectBody.purchase_units).toEqual(body.purchase_units);
  });

  it('reads an order back from the live base in live mode, in minor units', async () => {
    const calls = stubPaypal(null, {
      id: 'ORDER-NEW1',
      status: 'APPROVED',
      purchase_units: [{ custom_id: 'app_1:eu_1', amount: { currency_code: 'usd', value: '90.00' } }],
    });
    const snapshot = await new RealPaypalProvider(creds, 'live').getOrder('ORDER-NEW1');
    expect(calls.every((c) => c.url.startsWith('https://api-m.paypal.com/'))).toBe(true);
    expect(snapshot).toEqual({ id: 'ORDER-NEW1', status: 'APPROVED', customId: 'app_1:eu_1', amount: 9000, currency: 'USD' });
  });

  it('reads an order with more than one purchase unit as unverifiable, and an unknown one as null', async () => {
    stubPaypal(null, {
      id: 'ORDER-NEW1',
      status: 'APPROVED',
      purchase_units: [
        { custom_id: 'app_1:eu_1', amount: { currency_code: 'USD', value: '90.00' } },
        { custom_id: 'app_1:eu_1', amount: { currency_code: 'USD', value: '1.00' } },
      ],
    });
    expect(await new RealPaypalProvider(creds, 'test').getOrder('ORDER-NEW1')).toEqual({
      id: 'ORDER-NEW1',
      status: 'APPROVED',
      customId: null,
      amount: null,
      currency: null,
    });
    vi.restoreAllMocks();
    const calls = stubPaypal(null, null);
    expect(await new RealPaypalProvider(creds, 'test').getOrder('O-1/../x')).toBeNull();
    expect(calls.at(-1)!.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/O-1%2F..%2Fx');
  });

  describe('webhook registration', () => {
    function stubWebhookApi(patchStatus: number): Call[] {
      const calls: Call[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
        if (url.endsWith('/v1/notifications/webhooks') && init?.method === 'POST') {
          return new Response('{"name":"WEBHOOK_URL_ALREADY_EXISTS"}', { status: 400 });
        }
        if (url.endsWith('/v1/notifications/webhooks')) {
          return Response.json({ webhooks: [{ id: 'WH-OLD', url: 'https://api.example/hook' }] });
        }
        if (url.endsWith('/v1/notifications/webhooks/WH-OLD') && init?.method === 'PATCH') {
          return new Response(patchStatus < 300 ? '{}' : '{"name":"INVALID_REQUEST"}', { status: patchStatus });
        }
        return new Response('unexpected', { status: 500 });
      });
      return calls;
    }

    it('reuses a webhook already at the URL and replaces its events with the full set', async () => {
      const calls = stubWebhookApi(200);
      expect(await new RealPaypalProvider(creds, 'test').registerWebhook('https://api.example/hook')).toEqual({ webhookId: 'WH-OLD' });
      const patch = calls.find((c) => c.init?.method === 'PATCH')!;
      const body = JSON.parse(String(patch.init?.body)) as Array<{ op: string; path: string; value: Array<{ name: string }> }>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ op: 'replace', path: '/event_types' });
      expect(body[0]!.value.map((e) => e.name)).toEqual(
        expect.arrayContaining(['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'BILLING.SUBSCRIPTION.ACTIVATED']),
      );
    });

    it('fails the registration when PayPal refuses the event update', async () => {
      stubWebhookApi(400);
      await expect(new RealPaypalProvider(creds, 'test').registerWebhook('https://api.example/hook')).rejects.toMatchObject({
        code: 'BILLING_PROVIDER_REFUSED',
      });
    });
  });

  it('sends the same PayPal-Request-Id on every capture of an order, and treats already-captured as captured', async () => {
    const calls: Call[] = [];
    let captures = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.endsWith('/v2/checkout/orders/ORDER-NEW1/capture')) {
        captures += 1;
        return captures === 1
          ? Response.json({ id: 'ORDER-NEW1', status: 'COMPLETED' })
          : new Response('{"name":"UNPROCESSABLE_ENTITY","details":[{"issue":"ORDER_ALREADY_CAPTURED"}]}', { status: 422 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const provider = new RealPaypalProvider(creds, 'test');
    expect(await provider.captureOneTime('ORDER-NEW1')).toEqual({ captured: true });
    expect(await provider.captureOneTime('ORDER-NEW1')).toEqual({ captured: true });
    const ids = calls
      .filter((c) => c.url.endsWith('/capture'))
      .map((c) => new Headers(c.init?.headers).get('PayPal-Request-Id'));
    expect(ids).toEqual(['REKEY-CAPTURE-ORDER-NEW1', 'REKEY-CAPTURE-ORDER-NEW1']);
  });

  it('upper-cases the order currency once, for the order, the page and the SDK', async () => {
    const calls = stubPaypal();
    const result = await new RealPaypalProvider(creds, 'test').createEmbeddedCheckout({
      ...input,
      kind: 'one_time',
      plan: { ...plan, currency: 'usd' } as Plan,
    });
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!.init?.body)) as {
      purchase_units: Array<{ amount: { currency_code: string } }>;
    };
    expect(body.purchase_units[0]!.amount.currency_code).toBe('USD');
    expect(result.client).toMatchObject({ currency: 'USD' });
  });

  it('declares embedded checkout only with the methods and browser origins it needs', () => {
    const paypal = getModule('paypal')!;
    expect(paypal.capabilities.embeddedCheckout).toEqual({ recurring: true, oneTime: true });
    expect(typeof RealPaypalProvider.prototype.createEmbeddedCheckout).toBe('function');
    expect(typeof RealPaypalProvider.prototype.getSubscription).toBe('function');
    expect(typeof RealPaypalProvider.prototype.getOrder).toBe('function');
    expect(paypal.browser?.test.scriptSrc).toContain('https://www.sandbox.paypal.com');
    expect(paypal.browser?.live.scriptSrc.join(' ')).not.toContain('sandbox');
  });
});
