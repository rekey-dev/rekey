/**
 * What `RealStripeProvider` asks Stripe for on the Rekey checkout page, with
 * the SDK stubbed: the redirect flow's purchase in `ui_mode: 'elements'`, the
 * browser half of the result, the Checkout Session read-back, and the hosted
 * fallback that must expire the elements session before opening another.
 * Plus the publishable-key rules: mode match on save, readiness check 6, and
 * Stripe.js's release train tracking the pinned API version.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndUser, Plan } from '@prisma/client';
import { STRIPE_JS_RELEASE_TRAIN } from '@rekey.dev/shared-types';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import { browserCredentialCheck } from '../src/modules/billing/checkout/readiness.js';
import type { CheckoutSessionInput, HostedFallbackInput } from '../src/modules/billing/providers/types.js';

type Call = { op: string; params?: Record<string, unknown>; options?: Record<string, unknown>; id?: string };

const stub = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; params?: Record<string, unknown>; options?: Record<string, unknown>; id?: string }>,
  sessions: new Map<string, Record<string, unknown>>(),
  expireFails: false,
  keyInUseOnce: false,
}));

vi.mock('stripe', () => {
  class FakeStripe {
    coupons = {
      create: async (params: Record<string, unknown>) => {
        stub.calls.push({ op: 'coupons.create', params });
        return { id: 'co_minted' };
      },
      del: async (id: string) => {
        stub.calls.push({ op: 'coupons.del', id });
        return {};
      },
    };
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
          stub.calls.push({ op: 'create', params, ...(options && { options }) });
          if (stub.keyInUseOnce) {
            stub.keyInUseOnce = false;
            throw Object.assign(new Error('Key in use'), { code: 'idempotency_key_in_use' });
          }
          const elements = params.ui_mode === 'elements';
          return {
            id: elements ? 'cs_test_elements' : 'cs_test_hosted',
            ui_mode: elements ? 'elements' : 'hosted_page',
            client_secret: elements ? 'cs_test_elements_secret_abc' : null,
            url: elements ? null : 'https://checkout.stripe.com/c/pay/cs_test_hosted',
          };
        },
        retrieve: async (id: string) => {
          stub.calls.push({ op: 'retrieve', id });
          const session = stub.sessions.get(id);
          if (!session) throw Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' });
          return session;
        },
        expire: async (id: string) => {
          stub.calls.push({ op: 'expire', id });
          if (stub.expireFails) throw new Error('expire refused');
          stub.sessions.set(id, { ...stub.sessions.get(id), status: 'expired' });
          return stub.sessions.get(id);
        },
      },
    };
  }
  return { default: FakeStripe };
});

function input(over: Partial<CheckoutSessionInput> = {}): CheckoutSessionInput {
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
    ...over,
  };
}

const PAGE = 'https://portal.rekey.dev/app/checkout/chk_test_token';
const DISCOUNT = { amount: 1000, currency: 'USD', couponId: 'c_1', code: 'save10' };

function provider(publishableKey: string | undefined = 'pk_test_abc'): RealStripeProvider {
  return new RealStripeProvider({ apiKey: 'sk_test_secret', webhookSecret: 'whsec_x', ...(publishableKey !== undefined && { publishableKey }) });
}

function creates(): Call[] {
  return stub.calls.filter((c) => c.op === 'create');
}

function purchaseOnly(params: Record<string, unknown>): Record<string, unknown> {
  const { success_url: _s, cancel_url: _c, return_url: _r, ui_mode: _u, client_reference_id: _ref, ...rest } = params;
  return rest;
}

beforeEach(() => {
  stub.calls.length = 0;
  stub.sessions.clear();
  stub.expireFails = false;
  stub.keyInUseOnce = false;
});

describe('createEmbeddedCheckout', () => {
  it('creates the redirect flow’s subscription purchase in elements mode, returning to the page', async () => {
    const recurring = input({ trial: { days: 14 }, discount: DISCOUNT });
    const result = await provider().createEmbeddedCheckout({ ...recurring, kind: 'recurring', returnUrl: PAGE });
    await provider().createCheckoutSession(recurring);
    const [embedded, redirect] = creates().map((c) => c.params!);

    expect(embedded).toMatchObject({
      mode: 'subscription',
      ui_mode: 'elements',
      return_url: `${PAGE}?stripe_session_id={CHECKOUT_SESSION_ID}`,
      client_reference_id: 'app_1:eu_1',
      line_items: [{ price: 'price_fake', quantity: 1 }],
      discounts: [{ coupon: 'co_minted' }],
      subscription_data: { trial_period_days: 14, metadata: { applicationId: 'app_1', endUserId: 'eu_1', planId: 'pl_1' } },
    });
    expect(embedded).not.toHaveProperty('success_url');
    expect(embedded).not.toHaveProperty('cancel_url');
    expect(embedded).not.toHaveProperty('payment_method_types');
    expect(purchaseOnly(embedded!)).toEqual(purchaseOnly(redirect!));

    expect(result).toEqual({
      sessionId: 'cs_test_elements',
      client: { provider: 'stripe', publishableKey: 'pk_test_abc', clientSecret: 'cs_test_elements_secret_abc', sdk: 'elements' },
      fallbackUrl: null,
      providerPlanId: 'price_fake',
    });
    expect(JSON.stringify(result)).not.toContain('sk_test_secret');
  });

  it('creates a one-time payment in elements mode with its discount and no provider plan', async () => {
    const result = await provider().createEmbeddedCheckout({ ...input({ discount: DISCOUNT }), kind: 'one_time', returnUrl: PAGE });
    const [params] = creates().map((c) => c.params!);
    expect(params).toMatchObject({
      mode: 'payment',
      ui_mode: 'elements',
      discounts: [{ coupon: 'co_minted' }],
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 5000, product_data: { name: 'Pro' } } }],
      payment_intent_data: { metadata: { applicationId: 'app_1', endUserId: 'eu_1', planId: 'pl_1' } },
    });
    expect(result.providerPlanId).toBeNull();
  });

  it('refuses without a publishable key before creating anything at Stripe', async () => {
    await expect(provider('').createEmbeddedCheckout({ ...input(), kind: 'recurring', returnUrl: PAGE })).rejects.toMatchObject({
      code: 'CHECKOUT_EMBEDDED_NOT_READY',
    });
    expect(stub.calls).toEqual([]);
  });
});

describe('getCheckoutSession', () => {
  it('reports Stripe’s status, payment status and stamps', async () => {
    stub.sessions.set('cs_test_1', {
      id: 'cs_test_1',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'app_1:eu_1',
      metadata: { applicationId: 'app_1', endUserId: 'eu_1', planId: 'pl_1' },
      amount_total: 5000,
      currency: 'usd',
      url: null,
    });
    expect(await provider().getCheckoutSession('cs_test_1')).toEqual({
      id: 'cs_test_1',
      status: 'complete',
      paymentStatus: 'paid',
      clientReferenceId: 'app_1:eu_1',
      metadata: { applicationId: 'app_1', endUserId: 'eu_1', planId: 'pl_1' },
      amountTotal: 5000,
      currency: 'USD',
      url: null,
    });
  });

  it('answers null for a session Stripe does not have', async () => {
    expect(await provider().getCheckoutSession('cs_test_missing')).toBeNull();
  });
});

describe('createHostedFallback', () => {
  const ROW_EXPIRES = new Date(Date.now() + 6 * 60 * 60 * 1000);

  function fallbackInput(over: Partial<HostedFallbackInput> = {}): HostedFallbackInput {
    return {
      ...input({ successUrl: PAGE, cancelUrl: PAGE, trial: { days: 7 } }),
      kind: 'recurring',
      embeddedSessionId: 'cs_test_elements',
      idempotencyKey: 'rekey-checkout-fallback-row-cs_test_elements',
      priceId: 'price_at_creation',
      expiresAt: ROW_EXPIRES,
      ...over,
    };
  }

  function embedded(status: string, extra: Record<string, unknown> = {}): void {
    stub.sessions.set('cs_test_elements', {
      id: 'cs_test_elements',
      status,
      metadata: { applicationId: 'app_1' },
      discounts: [{ coupon: { id: 'co_minted' }, promotion_code: null }],
      amount_subtotal: 4200,
      currency: 'eur',
      ...extra,
    });
  }

  it('expires the open elements session before creating the hosted one, idempotently, with the same coupon and price', async () => {
    embedded('open');
    const result = await provider().createHostedFallback(fallbackInput());
    expect(stub.calls.map((c) => c.op)).toEqual(['retrieve', 'expire', 'create']);
    const create = creates()[0]!;
    expect(String(create.options!.idempotencyKey)).toMatch(/^rekey-checkout-fallback-row-cs_test_elements-[0-9a-f]{16}$/);
    expect(create.params).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_at_creation', quantity: 1 }],
      discounts: [{ coupon: 'co_minted' }],
      subscription_data: { trial_period_days: 7 },
      client_reference_id: 'app_1:eu_1',
      success_url: `${PAGE}?stripe_session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: PAGE,
      expires_at: Math.floor(ROW_EXPIRES.getTime() / 1000),
    });
    expect(create.params).not.toHaveProperty('ui_mode');
    expect(stub.calls.some((c) => c.op === 'coupons.create')).toBe(false);
    expect(result).toEqual({ sessionId: 'cs_test_hosted', url: 'https://checkout.stripe.com/c/pay/cs_test_hosted' });
  });

  it('charges a one-time purchase what the elements session charged, not the plan’s price now', async () => {
    embedded('open');
    await provider().createHostedFallback(fallbackInput({ kind: 'one_time', priceId: null }));
    expect(creates()[0]!.params).toMatchObject({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 4200 } }],
      discounts: [{ coupon: 'co_minted' }],
    });
  });

  it('refuses with under half an hour left, before touching the elements session', async () => {
    embedded('open');
    await expect(
      provider().createHostedFallback(fallbackInput({ expiresAt: new Date(Date.now() + 20 * 60 * 1000) })),
    ).rejects.toMatchObject({ code: 'CHECKOUT_FALLBACK_UNAVAILABLE' });
    expect(stub.calls.map((c) => c.op)).toEqual(['retrieve']);
  });

  it('refuses a paid elements session and creates nothing', async () => {
    embedded('complete');
    await expect(provider().createHostedFallback(fallbackInput())).rejects.toMatchObject({ code: 'CHECKOUT_SESSION_COMPLETE' });
    expect(creates()).toEqual([]);
  });

  it('goes on when an earlier attempt already expired the elements session', async () => {
    embedded('expired');
    await provider().createHostedFallback(fallbackInput());
    expect(stub.calls.map((c) => c.op)).toEqual(['retrieve', 'create']);
  });

  it('stops when the expire is refused and the session is still open', async () => {
    embedded('open');
    stub.expireFails = true;
    await expect(provider().createHostedFallback(fallbackInput())).rejects.toThrow('expire refused');
    expect(creates()).toEqual([]);
  });

  it('refuses a session another Application created', async () => {
    stub.sessions.set('cs_test_elements', { id: 'cs_test_elements', status: 'open', metadata: { applicationId: 'app_other' } });
    await expect(provider().createHostedFallback(fallbackInput())).rejects.toThrow();
    expect(stub.calls.map((c) => c.op)).toEqual(['retrieve']);
  });

  it('waits out a concurrent click holding the key, then retries with the same key', async () => {
    embedded('open');
    stub.keyInUseOnce = true;
    vi.useFakeTimers();
    try {
      const pending = provider().createHostedFallback(fallbackInput());
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
    const keys = creates().map((c) => c.options!.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('keys the replacement by its arguments, so changed arguments never hit idempotency_error', async () => {
    embedded('expired');
    await provider().createHostedFallback(fallbackInput());
    await provider().createHostedFallback(fallbackInput());
    await provider().createHostedFallback(fallbackInput({ endUser: { id: 'eu_1', email: 'renamed@example.com' } as unknown as EndUser }));
    const [a, b, c] = creates().map((x) => x.options!.idempotencyKey);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe('the redirect flow is unchanged by the shared builder', () => {
  // Generated by running the pre-refactor stripe-real.ts from
  // origin/workorder/stripe-api-version-bump against the same stub.
  const BEFORE = [{"mode":"subscription","line_items":[{"price":"price_fake","quantity":1}],"customer_email":"buyer@example.com","success_url":"https://app.example/ok","cancel_url":"https://app.example/cancel","metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"},"subscription_data":{"metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"}}},{"mode":"subscription","line_items":[{"price":"price_fake","quantity":1}],"customer_email":"buyer@example.com","success_url":"https://app.example/ok","cancel_url":"https://app.example/cancel","discounts":[{"coupon":"co_minted"}],"metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"},"subscription_data":{"trial_period_days":14,"metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"}}},{"mode":"payment","line_items":[{"quantity":1,"price_data":{"currency":"usd","unit_amount":5000,"product_data":{"name":"Pro"}}}],"customer_email":"buyer@example.com","success_url":"https://app.example/ok","cancel_url":"https://app.example/cancel","metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"},"payment_intent_data":{"metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"}}},{"mode":"payment","line_items":[{"quantity":1,"price_data":{"currency":"usd","unit_amount":5000,"product_data":{"name":"Pro"}}}],"customer_email":"buyer@example.com","success_url":"https://app.example/ok","cancel_url":"https://app.example/cancel","discounts":[{"coupon":"co_minted"}],"metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"},"payment_intent_data":{"metadata":{"applicationId":"app_1","endUserId":"eu_1","planId":"pl_1"}}}];

  it('sends exactly the pre-refactor params for subscription, trial plus coupon, one-time, and one-time plus coupon', async () => {
    await provider().createCheckoutSession(input());
    await provider().createCheckoutSession(input({ trial: { days: 14 }, discount: DISCOUNT }));
    await provider().createOneTimeCheckout(input());
    await provider().createOneTimeCheckout(input({ discount: DISCOUNT }));
    expect(creates().map((c) => c.params)).toEqual(BEFORE);
  });
});

describe('the publishable key', () => {
  it('is refused on save when its mode differs from the secret key', () => {
    expect(() => stripeModule.validateCredentials!({ apiKey: 'sk_live_1', publishableKey: 'pk_test_1' })).toThrow(
      expect.objectContaining({ code: 'BILLING_CREDENTIALS_INVALID' }),
    );
    expect(() => stripeModule.validateCredentials!({ apiKey: 'sk_test_1', publishableKey: 'pk_test_1' })).not.toThrow();
    expect(() => stripeModule.validateCredentials!({ apiKey: 'sk_live_1', publishableKey: '' })).not.toThrow();
  });

  it('readiness FAILs without it, FAILs on a mode mismatch, and names the panel path', () => {
    const missing = browserCredentialCheck('stripe', { apiKey: 'sk_live_1', publishableKey: '' });
    expect(missing).toMatchObject({ status: 'FAIL', id: 'browser_credential', provider: 'stripe' });
    expect(missing.fix).toContain('pk_live_');
    expect(missing.fix).toContain('Panel → Application → Billing → Setup → Providers → Stripe → Edit');

    const mismatched = browserCredentialCheck('stripe', { apiKey: 'sk_live_1', publishableKey: 'pk_test_1' });
    expect(mismatched.status).toBe('FAIL');
    expect(mismatched.message).toContain('test key');

    expect(browserCredentialCheck('stripe', { apiKey: 'sk_live_1', publishableKey: 'pk_live_1' }).status).toBe('PASS');
  });

  it('loads the Stripe.js release train of the pinned API version', () => {
    expect(STRIPE_API_VERSION.endsWith(`.${STRIPE_JS_RELEASE_TRAIN}`)).toBe(true);
  });
});
