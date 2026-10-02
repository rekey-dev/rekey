/**
 * The Invoice Payments reads that replaced `invoice.payment_intent` and
 * `charge.invoice` in `2025-03-31.basil`, run through the real SDK with only
 * the HTTP transport replaced, so the request Stripe would receive (path,
 * query, pinned version header) is what gets asserted.
 */

import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import {
  invoiceIdForPaymentIntent,
  paidInvoicePayments,
} from '../src/modules/billing/providers/stripe-invoice-payments.js';

interface Seen {
  url: URL;
  version: string | null;
}

function stripeReturning(data: unknown[]): { stripe: Stripe; seen: Seen[] } {
  const seen: Seen[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    seen.push({ url: new URL(String(input)), version: headers.get('stripe-version') });
    return new Response(JSON.stringify({ object: 'list', data, has_more: false, url: '/v1/invoice_payments' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
    });
  };
  const stripe = new Stripe('sk_test_invoice_payments', {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fakeFetch as typeof fetch),
  });
  return { stripe, seen };
}

describe('invoiceIdForPaymentIntent', () => {
  it('filters Invoice Payments by the payment intent, on the pinned version', async () => {
    const { stripe, seen } = stripeReturning([{ object: 'invoice_payment', invoice: 'in_1', status: 'paid' }]);
    await expect(invoiceIdForPaymentIntent(stripe, 'pi_1')).resolves.toBe('in_1');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.pathname).toBe('/v1/invoice_payments');
    expect(seen[0]!.url.searchParams.get('payment[type]')).toBe('payment_intent');
    expect(seen[0]!.url.searchParams.get('payment[payment_intent]')).toBe('pi_1');
    expect(seen[0]!.version).toBe(STRIPE_API_VERSION);
  });

  it('is null when the intent paid no invoice', async () => {
    const { stripe } = stripeReturning([]);
    await expect(invoiceIdForPaymentIntent(stripe, 'pi_one_time')).resolves.toBeNull();
  });

  it('is null when the intent paid more than one invoice', async () => {
    const { stripe } = stripeReturning([
      { object: 'invoice_payment', invoice: 'in_a' },
      { object: 'invoice_payment', invoice: 'in_b' },
    ]);
    await expect(invoiceIdForPaymentIntent(stripe, 'pi_multi')).resolves.toBeNull();
  });

  it('counts two payments against the same invoice as that invoice', async () => {
    const { stripe } = stripeReturning([
      { object: 'invoice_payment', invoice: 'in_same' },
      { object: 'invoice_payment', invoice: { id: 'in_same', object: 'invoice' } },
    ]);
    await expect(invoiceIdForPaymentIntent(stripe, 'pi_retry')).resolves.toBe('in_same');
  });
});

describe('paidInvoicePayments', () => {
  it('asks only for paid payments of the invoice, and counts those recorded outside Stripe apart', async () => {
    const { stripe, seen } = stripeReturning([
      { object: 'invoice_payment', status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_9' } },
      { object: 'invoice_payment', status: 'paid', payment: { type: 'charge', charge: { id: 'ch_9', object: 'charge' } } },
      { object: 'invoice_payment', status: 'paid', payment: { type: 'payment_record', payment_record: 'pr_9' } },
    ]);
    await expect(paidInvoicePayments(stripe, 'in_9')).resolves.toEqual({
      targets: [{ payment_intent: 'pi_9' }, { charge: 'ch_9' }],
      outsideStripe: 1,
    });
    expect(seen[0]!.url.searchParams.get('invoice')).toBe('in_9');
    expect(seen[0]!.url.searchParams.get('status')).toBe('paid');
  });
});
