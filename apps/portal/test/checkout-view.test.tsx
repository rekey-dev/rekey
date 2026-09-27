/**
 * The checkout page's rendered output: the test-mode banner, the states that
 * must show no order and no email, operator branding that cannot inject CSS
 * or script, and no inline script or style without the request's nonce.
 */

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CheckoutPageOrder, CheckoutPageView } from '@rekey.dev/shared-types';
import { CheckoutNotice, CheckoutView } from '@/components/checkout/checkout-view';
import { formatMoney, readableAccent, readableSurface } from '@/lib/checkout-format';
import { summariseCspReport } from '@/lib/csp-report';

const NONCE = 'test-nonce-123';
const EMAIL = 'buyer@example.com';

function order(overrides: Partial<CheckoutPageOrder['merchant']> = {}): CheckoutPageOrder {
  return {
    merchant: {
      displayName: 'Rekey Cloud',
      logoUrl: 'https://cdn.example/logo.png',
      primaryColor: '#0d9488',
      backgroundColor: null,
      surfaceColor: null,
      supportEmail: 'help@example.com',
      supportUrl: null,
      termsUrl: 'https://example.com/terms',
      privacyUrl: null,
      refundUrl: null,
      ...overrides,
    },
    plan: { name: 'Cloud Standard', amount: 9900, currency: 'USD', interval: 'MONTH', kind: 'recurring' },
    discountAmount: 0,
    totalDueToday: 9900,
    buyerEmail: EMAIL,
    successUrl: 'https://app.example/account?paid=1',
    cancelUrl: 'https://app.example/account',
    manageUrl: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    client: { provider: 'paypal', clientId: 'client-id', subscriptionId: 'I-ABC', sdk: 'v5-subscription' },
  };
}

function view(mode: 'test' | 'live', o: CheckoutPageOrder = order()): CheckoutPageView {
  return { status: 'open', slug: 'acme', paymentMode: mode, provider: 'paypal', returnUrl: o.cancelUrl, order: o };
}

function render(mode: 'test' | 'live', o: CheckoutPageOrder = order()): string {
  const v = view(mode, o);
  return renderToStaticMarkup(
    <CheckoutView view={v} order={o} nonce={NONCE} basePath="/acme/checkout/chk_test_x" locale="en-US" />,
  );
}

describe('checkout page', () => {
  it('shows the test banner in test mode and never in live mode', () => {
    expect(render('test')).toContain('Test mode: no real money moves.');
    expect(render('live')).not.toContain('Test mode');
  });

  it('shows the order summary, the full email and the renewal disclosure', () => {
    const html = render('live');
    expect(html).toContain('Cloud Standard');
    expect(html).toContain('$99.00');
    expect(html).toContain(EMAIL);
    expect(html).toContain('Renews automatically at $99.00 every month until you cancel.');
    expect(html).toContain('Payments are processed securely by PayPal.');
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
  });

  it('puts the nonce on every inline script and style it renders', () => {
    const html = render('test');
    const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain(`nonce="${NONCE}"`);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('cannot be made to inject CSS or script through branding', () => {
    const html = render(
      'live',
      order({
        primaryColor: 'red;}body{display:none',
        backgroundColor: '#000;}</style><script>alert(1)</script>',
        logoUrl: 'javascript:alert(1)',
        termsUrl: 'javascript:alert(2)',
        displayName: '<img src=x onerror=alert(3)>',
      }),
    );
    expect(html).not.toContain('display:none');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img src=x');
  });

  it('shows no order and no email on the expired and already-paid pages', () => {
    for (const title of ['This checkout has expired', 'This checkout is already paid']) {
      const html = renderToStaticMarkup(
        <CheckoutNotice title={title} body="Nothing has been charged." returnUrl="https://app.example/account" returnLabel="Return to the app" testMode={false} />,
      );
      expect(html).toContain(title);
      expect(html).not.toContain(EMAIL);
      expect(html).not.toContain('Cloud Standard');
      expect(html).not.toContain('$99');
    }
  });
});

describe('checkout formatting', () => {
  it('groups rupees the Indian way', () => {
    expect(formatMoney(10_000_000, 'INR', 'en-IN')).toBe('₹1,00,000.00');
  });

  it('keeps an operator accent only when it is readable on white', () => {
    expect(readableAccent('#0f766e')).toBe('#0f766e');
    expect(readableAccent('#0d9488')).toBe('#171717');
    expect(readableAccent('#ffeb3b')).toBe('#171717');
    expect(readableSurface('#111111')).toBeNull();
    expect(readableSurface('#fafafa')).toBe('#fafafa');
  });
});

describe('CSP reports', () => {
  it('keeps the checkout token out of the log line', () => {
    const summary = summariseCspReport(
      JSON.stringify({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'https://evil.example/skim.js?x=1',
          'document-uri': `https://portal.example/acme/checkout/chk_live_${'C'.repeat(43)}`,
        },
      }),
    );
    expect(summary).toEqual({ directive: 'script-src', blocked: 'https://evil.example', page: 'https://portal.example' });
    expect(summariseCspReport('not json')).toBeNull();
  });
});
