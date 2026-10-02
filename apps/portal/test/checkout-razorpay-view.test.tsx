/**
 * The checkout page for a Razorpay session: the shared layout with Razorpay's
 * words from the provider copy, our own pay region, and a fallback that works
 * with scripts blocked (a link for a subscription, the same order posted to
 * Razorpay Hosted Checkout for a one-time purchase).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CheckoutPageOrder, CheckoutPageView } from '@rekey.dev/shared-types';
import { CheckoutView } from '@/components/checkout/checkout-view';

const BASE = '/acme/checkout/chk_test_x';

function order(target: { kind: 'subscription'; subscriptionId: string } | { kind: 'order'; orderId: string }): CheckoutPageOrder {
  const oneTime = target.kind === 'order';
  return {
    merchant: {
      displayName: 'Acme Labs',
      logoUrl: 'https://cdn.example/logo.png',
      primaryColor: '#0d9488',
      backgroundColor: null,
      surfaceColor: null,
      supportEmail: null,
      supportUrl: null,
      termsUrl: null,
      privacyUrl: null,
      refundUrl: null,
    },
    plan: oneTime
      ? { name: '100 credits', amount: 19900, currency: 'INR', interval: null, kind: 'one_time' }
      : { name: 'Standard', amount: 49900, currency: 'INR', interval: 'MONTH', kind: 'recurring' },
    discountAmount: 0,
    totalDueToday: oneTime ? 19900 : 49900,
    buyerEmail: 'buyer@example.com',
    successUrl: 'https://app.example/account?paid=1',
    cancelUrl: 'https://app.example/account',
    manageUrl: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    client: { provider: 'razorpay', keyId: 'rzp_test_ci', sdk: 'razorpay-checkout', target },
  };
}

function render(o: CheckoutPageOrder, mode: 'test' | 'live' = 'test', razorpayReturn: 'paid' | 'unconfirmed' | 'failed' | null = null): string {
  const view: CheckoutPageView = { status: 'open', slug: 'acme', paymentMode: mode, provider: 'razorpay', returnUrl: o.cancelUrl, order: o };
  return renderToStaticMarkup(
    <CheckoutView view={view} order={o} nonce="n0nce" basePath={BASE} locale="en-IN" razorpayReturn={razorpayReturn} />,
  );
}

describe('checkout page, Razorpay session', () => {
  it("names Razorpay in the test banner and the footer, and never PayPal", () => {
    const html = render(order({ kind: 'subscription', subscriptionId: 'sub_1' }));
    expect(html).toContain('Test mode: no real money moves. Pay with Razorpay&#x27;s test cards or its UPI test flow.');
    expect(html).toContain('Payments are processed securely by Razorpay.');
    expect(html).not.toContain('PayPal');
    expect(render(order({ kind: 'subscription', subscriptionId: 'sub_1' }), 'live')).not.toContain('Test mode');
  });

  it('keeps the shared layout: branding, summary, renewal terms', () => {
    const html = render(order({ kind: 'subscription', subscriptionId: 'sub_1' }));
    expect(html).toContain('Acme Labs');
    expect(html).toContain('Subscribe to');
    expect(html).toContain('Renews automatically at ₹499.00 every month until you cancel.');
  });

  it('falls back to the host-checked continue route for a subscription', () => {
    const html = render(order({ kind: 'subscription', subscriptionId: 'sub_1' }));
    const noscript = /<noscript>(.*?)<\/noscript>/s.exec(html)?.[1] ?? '';
    expect(noscript).toContain(`href="${BASE}/continue"`);
    expect(noscript).toContain('Continue on Razorpay');
    expect(noscript).not.toContain('<form');
  });

  it('posts a one-time order to Razorpay Hosted Checkout with public fields only', () => {
    const html = render(order({ kind: 'order', orderId: 'order_9' }));
    expect(html).toContain('Buy');
    const noscript = /<noscript>(.*?)<\/noscript>/s.exec(html)?.[1] ?? '';
    expect(noscript).toContain('action="https://api.razorpay.com/v1/checkout/embedded"');
    const fields = Object.fromEntries([...noscript.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect(fields).toMatchObject({
      key_id: 'rzp_test_ci',
      order_id: 'order_9',
      amount: '19900',
      currency: 'INR',
      name: 'Acme Labs',
      image: 'https://cdn.example/logo.png',
      'prefill[email]': 'buyer@example.com',
    });
    expect(fields.callback_url).toMatch(/\/acme\/checkout\/chk_test_x\/razorpay\/return$/);
    expect(fields.cancel_url).toMatch(/\/acme\/checkout\/chk_test_x$/);
    expect(Object.keys(fields).sort()).toEqual(
      ['amount', 'callback_url', 'cancel_url', 'currency', 'description', 'image', 'key_id', 'name', 'order_id', 'prefill[email]'].sort(),
    );
  });

  it('renders the pay region as a skeleton until checkout.js loads, with no inline script', () => {
    const html = render(order({ kind: 'order', orderId: 'order_9' }));
    expect(html).toContain('ck-button-skeleton');
    expect(html).not.toMatch(/<script(?![^>]*nonce="n0nce")/);
  });

  it('waits for the webhook, with no Pay button, after Hosted Checkout returned paid', () => {
    const html = render(order({ kind: 'order', orderId: 'order_9' }), 'test', 'paid');
    expect(html).toContain('Payment received. Confirming your payment…');
    expect(html).not.toContain('ck-button');
  });

  it('shows the do-not-pay-again message, and no Pay button, after Hosted Checkout returned a refused payment', () => {
    const html = render(order({ kind: 'order', orderId: 'order_9' }), 'test', 'unconfirmed');
    expect(html).toContain('We could not confirm this payment with Razorpay. Please do not pay again');
    expect(html).not.toContain('ck-button');
  });

  it('says a failed Hosted Checkout payment was not charged', () => {
    const html = render(order({ kind: 'order', orderId: 'order_9' }), 'test', 'failed');
    expect(html).toContain('The payment failed. You have not been charged.');
  });
});
