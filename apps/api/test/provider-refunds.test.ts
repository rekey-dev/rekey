/**
 * Provider refund capability — the three real implementations, unit-tested
 * against stubbed provider clients.
 *
 * These classes are normally unreachable from the suite: `test/setup.ts` mocks
 * `getProviderForApplication` for every test, so the fakes in
 * `test/fakes/billing-providers.ts` stand in and nothing ever exercises the
 * code that talks to Stripe, PayPal or Razorpay. That is the right default for
 * route tests and it is exactly why the Razorpay `cancel_at_cycle_end`
 * inversion survived (see the comment on `cancelSubscription`): the fake
 * records the call and never asks the provider what it meant.
 *
 * Refunds move money OUT, so the same blind spot is more expensive here. These
 * tests instantiate the real classes directly and replace only the HTTP client
 * underneath, so the request each provider actually builds — endpoint, field
 * names, id — is what gets asserted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import { RealPaypalProvider } from '../src/modules/billing/providers/paypal.js';
import { RealRazorpayProvider } from '../src/modules/billing/providers/razorpay.js';
import { getModule, registryNames } from '../src/modules/billing/providers/registry.js';
import type { RefundPaymentInput } from '../src/modules/billing/providers/types.js';

const REFUND: RefundPaymentInput = {
  providerPaymentId: 'replaced per test',
  idempotencyKey: 'rekey-refund-test-key-0001',
};

/** Swap a private client field on a constructed provider. */
function withClient<T>(provider: T, field: string, client: unknown): T {
  (provider as unknown as Record<string, unknown>)[field] = client;
  return provider;
}

describe('capability declaration matches implementation', () => {
  // A module that advertises refunds to the panel but whose provider cannot
  // perform one sends the operator to a button that fails only after they have
  // told a customer the money is coming back.
  it.each(registryNames)('%s: declares refunds iff its provider implements it', (name) => {
    const mod = getModule(name);
    expect(mod, `no module registered for ${name}`).toBeDefined();
    const impl: Record<string, unknown> =
      name === 'stripe'
        ? new RealStripeProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x' })
        : name === 'paypal'
          ? new RealPaypalProvider({ clientId: 'c', clientSecret: 's', webhookId: 'w' }, 'test')
          : new RealRazorpayProvider({ keyId: 'rzp_test_x', keySecret: 'k' });
    expect(typeof impl.refundPayment === 'function').toBe(Boolean(mod!.capabilities.refunds));
  });

  it('all three declare partial refunds, and only Stripe has no window', () => {
    expect(getModule('stripe')!.capabilities.refunds).toEqual({ partial: true, windowDays: null });
    expect(getModule('paypal')!.capabilities.refunds).toEqual({ partial: true, windowDays: 180 });
    expect(getModule('razorpay')!.capabilities.refunds).toEqual({ partial: true, windowDays: 180 });
  });
});

describe('stripe: resolving the stored id to something refundable', () => {
  /**
   * The defect these cover. `Payment.providerPaymentId` holds an INVOICE id
   * for every renewal (`invoice.payment_succeeded` → `providerPaymentId:
   * invoice.id`) and a Checkout Session id for a first payment with no
   * PaymentIntent yet, while Stripe's Refunds API accepts only `charge` or
   * `payment_intent`. Passing the column through unexamined refuses the
   * majority of real refunds.
   */
  function stripeStub(overrides: Record<string, unknown> = {}) {
    const create = vi.fn().mockResolvedValue({
      id: 're_1',
      amount: 500,
      currency: 'usd',
      status: 'succeeded',
    });
    const invoiceRetrieve = vi.fn().mockResolvedValue({ payment_intent: 'pi_from_invoice' });
    const sessionRetrieve = vi.fn().mockResolvedValue({ payment_intent: 'pi_from_session' });
    const provider = withClient(
      new RealStripeProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x' }),
      'stripe',
      {
        refunds: { create },
        invoices: { retrieve: invoiceRetrieve },
        checkout: { sessions: { retrieve: sessionRetrieve } },
        ...overrides,
      },
    );
    return { provider, create, invoiceRetrieve, sessionRetrieve };
  }

  it('resolves an invoice id to its payment intent before refunding', async () => {
    const { provider, create, invoiceRetrieve } = stripeStub();
    await provider.refundPayment({ ...REFUND, providerPaymentId: 'in_renewal_42' });

    expect(invoiceRetrieve).toHaveBeenCalledWith('in_renewal_42');
    // The assertion that matters: the INVOICE id never reaches the Refunds
    // API. Deleting the `in_` branch sends `payment_intent: 'in_renewal_42'`
    // and this fails.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_from_invoice' }),
      { idempotencyKey: REFUND.idempotencyKey },
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('charge');
  });

  it('resolves a checkout session id to its payment intent', async () => {
    const { provider, create, sessionRetrieve } = stripeStub();
    await provider.refundPayment({ ...REFUND, providerPaymentId: 'cs_first_payment' });

    expect(sessionRetrieve).toHaveBeenCalledWith('cs_first_payment');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_from_session' }),
      expect.anything(),
    );
  });

  it('passes a payment intent through without a lookup', async () => {
    const { provider, create, invoiceRetrieve, sessionRetrieve } = stripeStub();
    await provider.refundPayment({ ...REFUND, providerPaymentId: 'pi_direct' });

    expect(invoiceRetrieve).not.toHaveBeenCalled();
    expect(sessionRetrieve).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_direct' }),
      expect.anything(),
    );
  });

  it('passes a charge id through as a charge, not a payment intent', async () => {
    const { provider, create } = stripeStub();
    await provider.refundPayment({ ...REFUND, providerPaymentId: 'ch_legacy' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: 'ch_legacy' }),
      expect.anything(),
    );
  });

  it('refuses an invoice that was never paid rather than calling Stripe', async () => {
    const { provider, create } = stripeStub({
      invoices: { retrieve: vi.fn().mockResolvedValue({ payment_intent: null }) },
    });
    await expect(
      provider.refundPayment({ ...REFUND, providerPaymentId: 'in_unpaid' }),
    ).rejects.toMatchObject({ code: 'BILLING_PAYMENT_NOT_REFUNDABLE' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an id whose kind it does not recognise', async () => {
    const { provider, create } = stripeStub();
    await expect(
      provider.refundPayment({ ...REFUND, providerPaymentId: 'xx_something_new' }),
    ).rejects.toMatchObject({ code: 'BILLING_PAYMENT_NOT_REFUNDABLE' });
    // Matching by prefix means a future Stripe id kind fails as unrecognised
    // instead of being posted as a payment intent and refused opaquely.
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a non-succeeded refund as pending rather than as money moved', async () => {
    const { provider } = stripeStub({
      refunds: {
        create: vi
          .fn()
          .mockResolvedValue({ id: 're_2', amount: 500, currency: 'usd', status: 'pending' }),
      },
    });
    const res = await provider.refundPayment({ ...REFUND, providerPaymentId: 'pi_x' });
    expect(res.status).toBe('pending');
  });

  it('maps an already-refunded charge to something the operator can act on', async () => {
    const { provider } = stripeStub({
      refunds: {
        create: vi.fn().mockRejectedValue(
          Object.assign(new Error('Charge already refunded'), {
            code: 'charge_already_refunded',
          }),
        ),
      },
    });
    await expect(
      provider.refundPayment({ ...REFUND, providerPaymentId: 'pi_x' }),
    ).rejects.toMatchObject({ code: 'BILLING_PAYMENT_ALREADY_REFUNDED' });
  });
});

describe('paypal: choosing between the v1 sale and v2 capture refund', () => {
  const creds = { clientId: 'c', clientSecret: 's', webhookId: 'w' };
  type Call = { url: string; body: Record<string, unknown> };

  /**
   * Stub `fetch` for the token exchange plus a scripted sequence of refund
   * responses, recording every refund request so the endpoint AND the body's
   * field names can both be asserted — they differ between the two API
   * versions, and crossing them produces a confusing 400.
   */
  function paypalFetchStub(responses: Array<{ status: number; body: unknown }>) {
    const calls: Call[] = [];
    let i = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      calls.push({ url, body: JSON.parse((init?.body as string) ?? '{}') });
      const next = responses[i++] ?? responses[responses.length - 1];
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the v1 sale resource when v2 does not know the id', async () => {
    const calls = paypalFetchStub([
      { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } },
      { status: 201, body: { id: 'ref_1', state: 'completed', amount: { total: '9.99', currency: 'USD' } } },
    ]);
    const provider = new RealPaypalProvider(creds, 'test');
    const res = await provider.refundPayment({
      ...REFUND,
      providerPaymentId: '5TY05013RG002845M',
      amount: 999,
      currency: 'USD',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/v2/payments/captures/5TY05013RG002845M/refund');
    expect(calls[1].url).toContain('/v1/payments/sale/5TY05013RG002845M/refund');
    // v2 takes `value`/`currency_code`; v1 takes `total`/`currency`. Sending
    // v2's names to v1 is a 400 that reads like a broken integration.
    expect(calls[0].body.amount).toEqual({ value: '9.99', currency_code: 'USD' });
    expect(calls[1].body.amount).toEqual({ total: '9.99', currency: 'USD' });
    expect(res).toMatchObject({ refundId: 'ref_1', amount: 999, status: 'succeeded' });
  });

  it('posts to the href PayPal gave us and never guesses an endpoint', async () => {
    const calls = paypalFetchStub([
      { status: 201, body: { id: 'ref_2', status: 'COMPLETED', amount: { value: '5.00', currency_code: 'USD' } } },
    ]);
    const provider = new RealPaypalProvider(creds, 'test');
    await provider.refundPayment({
      ...REFUND,
      providerPaymentId: 'ignored-when-href-present',
      refundHref: 'https://api-m.sandbox.paypal.com/v2/payments/captures/ABC/refund',
      amount: 500,
      currency: 'USD',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/ABC/refund');
    expect(calls[0].url).not.toContain('ignored-when-href-present');
  });

  it('sends note_to_payer, not note', async () => {
    // PayPal's own examples show `note`, contradicting their schema. `note` is
    // dropped silently, so the buyer never sees the reason.
    const calls = paypalFetchStub([
      { status: 201, body: { id: 'ref_3', status: 'COMPLETED', amount: { value: '1.00', currency_code: 'USD' } } },
    ]);
    const provider = new RealPaypalProvider(creds, 'test');
    await provider.refundPayment({
      ...REFUND,
      providerPaymentId: 'CAP1',
      amount: 100,
      currency: 'USD',
      reason: 'Duplicate charge',
    });
    expect(calls[0].body).toHaveProperty('note_to_payer', 'Duplicate charge');
    expect(calls[0].body).not.toHaveProperty('note');
  });

  it('sends an empty body for a full refund', async () => {
    const calls = paypalFetchStub([
      { status: 201, body: { id: 'ref_4', status: 'COMPLETED' } },
    ]);
    const provider = new RealPaypalProvider(creds, 'test');
    await provider.refundPayment({ ...REFUND, providerPaymentId: 'CAP2' });
    // An empty payload is how PayPal is told "all of what remains". Sending a
    // computed amount instead would be us guessing at the remainder.
    expect(calls[0].body).toEqual({});
  });

  it('maps the 180-day refusal to a distinct code', async () => {
    paypalFetchStub([
      {
        status: 422,
        body: { details: [{ issue: 'REFUND_NOT_ALLOWED_AFTER_180_DAYS' }] },
      },
    ]);
    const provider = new RealPaypalProvider(creds, 'test');
    await expect(
      provider.refundPayment({ ...REFUND, providerPaymentId: 'CAP3' }),
    ).rejects.toMatchObject({ code: 'BILLING_REFUND_WINDOW_CLOSED' });
  });

  it('treats a PENDING refund as not yet moved', async () => {
    paypalFetchStub([
      { status: 201, body: { id: 'ref_5', status: 'PENDING', amount: { value: '1.00', currency_code: 'USD' } } },
    ]);
    const provider = new RealPaypalProvider(creds, 'test');
    const res = await provider.refundPayment({ ...REFUND, providerPaymentId: 'CAP4' });
    expect(res.status).toBe('pending');
  });
});

describe('razorpay: refund creation and its refusals', () => {
  function razorpayStub(refund: unknown, rejects = false) {
    const fn = rejects ? vi.fn().mockRejectedValue(refund) : vi.fn().mockResolvedValue(refund);
    const provider = withClient(new RealRazorpayProvider({ keyId: 'rzp_test_x', keySecret: 'k' }), 'client', {
      payments: { refund: fn },
    });
    return { provider, fn };
  }

  it('refunds the pay_ id with the idempotency key as the receipt', async () => {
    const { provider, fn } = razorpayStub({
      id: 'rfnd_1',
      amount: 4900,
      currency: 'INR',
      status: 'pending',
    });
    const res = await provider.refundPayment({
      ...REFUND,
      providerPaymentId: 'pay_ABC123',
      amount: 4900,
    });

    expect(fn).toHaveBeenCalledWith(
      'pay_ABC123',
      expect.objectContaining({ amount: 4900, receipt: REFUND.idempotencyKey }),
    );
    // Razorpay CREATES every refund pending and reports the outcome on
    // `refund.processed`. Reporting this as succeeded would tell an operator
    // the money moved when it has not.
    expect(res.status).toBe('pending');
  });

  it('reports a processed refund as succeeded', async () => {
    const { provider } = razorpayStub({
      id: 'rfnd_2',
      amount: 100,
      currency: 'INR',
      status: 'processed',
    });
    const res = await provider.refundPayment({ ...REFUND, providerPaymentId: 'pay_X' });
    expect(res.status).toBe('succeeded');
  });

  it('omits the amount for a full refund rather than computing one', async () => {
    const { provider, fn } = razorpayStub({ id: 'rfnd_3', status: 'pending' });
    await provider.refundPayment({ ...REFUND, providerPaymentId: 'pay_Y' });
    expect(fn.mock.calls[0][1]).not.toHaveProperty('amount');
  });

  it('maps the six-month cliff to a distinct code', async () => {
    const { provider } = razorpayStub(
      { error: { description: 'Refund is not supported by the bank because the payment is more than 6 months old' } },
      true,
    );
    await expect(
      provider.refundPayment({ ...REFUND, providerPaymentId: 'pay_OLD' }),
    ).rejects.toMatchObject({ code: 'BILLING_REFUND_WINDOW_CLOSED' });
  });

  it('maps a duplicate receipt to a distinct code, since a retry would pay twice', async () => {
    const { provider } = razorpayStub(
      { error: { description: 'Duplicate receipt found for this refund request.' } },
      true,
    );
    await expect(
      provider.refundPayment({ ...REFUND, providerPaymentId: 'pay_DUP' }),
    ).rejects.toMatchObject({ code: 'BILLING_REFUND_ALREADY_REQUESTED' });
  });
});
