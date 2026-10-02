/**
 * Stripe on the checkout page: the shared layout with Stripe's words from the
 * provider lookup, the payment region's configuration (Stripe.js URL, the
 * Appearance themed from the Application's colours, our Pay button), the
 * return from a redirecting payment method, the confirmation route's
 * refusals, and the CSP admitting Stripe's origins.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutPageOrder, CheckoutPageView } from '@rekey.dev/shared-types';
import type { CheckoutLookup } from '@/lib/checkout-api';

const lookup = vi.fn<(token: string) => Promise<CheckoutLookup>>();
const confirmStripe = vi.fn(async () => ({ status: 200, body: { status: 'confirming' } }));
const confirmApproval = vi.fn(async () => ({ status: 200, body: { status: 'confirming' } }));
vi.mock('@/lib/checkout-api', () => ({
  lookupCheckout: (t: string) => lookup(t),
  confirmApproval: (...args: unknown[]) => confirmApproval(...(args as [])),
  confirmStripe: (...args: unknown[]) => confirmStripe(...(args as [])),
  isCheckoutToken: (t: string) => t.startsWith('chk_'),
}));
const redirected = vi.fn((to: string) => {
  throw new Error(`REDIRECT ${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirected(to) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-nonce': 'page-nonce', 'accept-language': 'en-US' }),
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example' }));

const { default: CheckoutPage } = await import('@/app/(checkout)/[slug]/checkout/[token]/page');
const { POST } = await import('@/app/(checkout)/[slug]/checkout/[token]/stripe-confirmed/route');
const { CheckoutView } = await import('@/components/checkout/checkout-view');
const { StripePayment } = await import('@/components/checkout/stripe-payment');
const { STRIPE_JS_URL, payButtonLabel, sessionPayLabel } = await import('@/lib/stripe-elements');
const { stripeAppearance } = await import('@/lib/stripe-appearance');
const { buildCheckoutCsp } = await import('@/lib/checkout-csp');
const { CHECKOUT_PAGE_PROVIDERS } = await import('@rekey.dev/shared-types/checkout');

const TOKEN = `chk_test_${'S'.repeat(43)}`;
const SESSION = 'cs_test_a1B2c3D4';
const STRIPE_CLIENT = { provider: 'stripe', publishableKey: 'pk_test_abc', clientSecret: `${SESSION}_secret_x`, sdk: 'elements' } as const;

function order(over: Partial<CheckoutPageOrder> = {}): CheckoutPageOrder {
  return {
    merchant: {
      displayName: 'Acme',
      logoUrl: null,
      primaryColor: '#4f46e5',
      backgroundColor: null,
      surfaceColor: '#fafafa',
      supportEmail: null,
      supportUrl: null,
      termsUrl: null,
      privacyUrl: null,
      refundUrl: null,
    },
    plan: { name: 'Pro', amount: 9900, currency: 'USD', interval: 'MONTH', kind: 'recurring' },
    discountAmount: 0,
    totalDueToday: 9900,
    buyerEmail: 'buyer@example.com',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/account',
    manageUrl: null,
    expiresAt: new Date().toISOString(),
    client: STRIPE_CLIENT,
    ...over,
  };
}

function view(o: CheckoutPageOrder = order(), status: CheckoutPageView['status'] = 'open'): CheckoutPageView {
  return { status, slug: 'acme', paymentMode: 'test', provider: 'stripe', returnUrl: o.cancelUrl, order: o };
}

function renderView(o: CheckoutPageOrder = order()): string {
  return renderToStaticMarkup(<CheckoutView view={view(o)} order={o} nonce="n" basePath={`/acme/checkout/${TOKEN}`} locale="en-US" />);
}

describe('the shared layout with Stripe', () => {
  it('uses Stripe’s words from the lookup and renders the Stripe region, not PayPal’s', () => {
    const html = renderView();
    expect(html).toContain('Test mode: no real money moves. Use Stripe test card 4242 4242 4242 4242');
    expect(html).toContain('Payments are processed securely by Stripe.');
    expect(html).toContain('Continue on Stripe');
    expect(html).toContain('id="stripe-payment-element"');
    expect(html).toContain('Pay $99.00');
    expect(html).not.toContain('paypal');
    expect(html).not.toContain('PayPal');
  });

  it('shows the same summary for a one-time purchase, headed Buy', () => {
    const html = renderView(order({ plan: { name: 'Credits', amount: 500, currency: 'USD', interval: null, kind: 'one_time' }, totalDueToday: 500 }));
    expect(html).toContain('Buy Credits');
    expect(html).not.toContain('Renews automatically');
  });
});

describe('the Stripe payment region', () => {
  function region(initialPhase: 'loading' | 'confirming'): string {
    return renderToStaticMarkup(
      <StripePayment
        nonce="n"
        client={STRIPE_CLIENT}
        appearance={stripeAppearance(order().merchant)}
        payLabel="Pay $99.00"
        basePath="/acme/checkout/x"
        successUrl="https://app.example/ok"
        initialPhase={initialPhase}
        providerName="Stripe"
        fallbackLabel="Continue on Stripe"
      />,
    );
  }

  it('starts with a skeleton and a disabled Pay button, and no form while confirming', () => {
    const loading = region('loading');
    expect(loading).toContain('data-testid="stripe-skeleton"');
    expect(loading).toMatch(/<button[^>]*disabled[^>]*>Pay \$99\.00<\/button>/);
    expect(loading).toMatch(/id="stripe-payment-element" class="opacity-0"/);
    const confirming = region('confirming');
    expect(confirming).not.toContain('<button');
    expect(confirming).toContain('Payment received. Confirming your payment');
  });

  it('loads Stripe.js from js.stripe.com on the pinned release train', () => {
    expect(STRIPE_JS_URL).toMatch(/^https:\/\/js\.stripe\.com\/[a-z]+\/stripe\.js$/);
  });

  it('themes the Payment Element from the Application’s colours, after the contrast checks', () => {
    expect(stripeAppearance({ primaryColor: '#4f46e5', surfaceColor: '#fafafa' }).variables).toMatchObject({
      colorPrimary: '#4f46e5',
      colorBackground: '#fafafa',
      colorText: '#171717',
    });
    const unsafe = stripeAppearance({ primaryColor: 'red;}body{display:none', surfaceColor: '#000000' }).variables;
    expect(unsafe.colorPrimary).toBe('#171717');
    expect(unsafe.colorBackground).toBe('#ffffff');
  });

  it('labels the Pay button from Stripe’s session total once it has loaded', () => {
    const session = (minor: number, amount: string, recurring: unknown) => ({
      id: 'cs_test_x',
      canConfirm: true,
      recurring,
      total: { total: { minorUnitsAmount: minor, amount } },
    });
    expect(sessionPayLabel(session(10890, '$108.90', null))).toBe('Pay $108.90');
    expect(sessionPayLabel(session(0, '$0.00', { interval: 'month' }))).toBe('Start free trial');
    expect(sessionPayLabel(session(0, '$0.00', null))).toBe('Confirm order');
  });

  it('labels the Pay button with the amount due, or with what starts when nothing is due', () => {
    expect(payButtonLabel(order(), '$99.00')).toBe('Pay $99.00');
    expect(payButtonLabel(order({ totalDueToday: 0 }), '$0.00')).toBe('Start free trial');
    expect(payButtonLabel(order({ totalDueToday: 0, discountAmount: 9900 }), '$0.00')).toBe('Confirm order');
  });
});

describe('returning from a redirecting payment method', () => {
  beforeEach(() => {
    confirmStripe.mockClear();
    redirected.mockClear();
    lookup.mockResolvedValue({ kind: 'view', view: view() });
  });

  async function visit(query: Record<string, string>): Promise<string> {
    const element = await CheckoutPage({ params: Promise.resolve({ slug: 'acme', token: TOKEN }), searchParams: Promise.resolve(query) });
    return renderToStaticMarkup(element);
  }

  it('checks the returned session with the API, then strips the query', async () => {
    await expect(visit({ stripe_session_id: SESSION })).rejects.toThrow(`REDIRECT /acme/checkout/${TOKEN}`);
    expect(confirmStripe).toHaveBeenCalledWith(TOKEN, SESSION, 'return');
  });

  it('strips a malformed id without asking the API', async () => {
    await expect(visit({ stripe_session_id: 'javascript:alert(1)' })).rejects.toThrow('REDIRECT');
    expect(confirmStripe).not.toHaveBeenCalled();
  });

  it('renders the Stripe page for an open Stripe session', async () => {
    const html = await visit({});
    expect(html).toContain('id="stripe-payment-element"');
  });
});

describe('POST …/stripe-confirmed', () => {
  const params = { params: Promise.resolve({ slug: 'acme', token: TOKEN }) };
  function request(headers: Record<string, string>, body: unknown): Request {
    return new Request(`https://portal.example/acme/checkout/${TOKEN}/stripe-confirmed`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  beforeEach(() => confirmStripe.mockClear());

  it('forwards a same-origin JSON confirmation', async () => {
    const res = await POST(request({ origin: 'https://portal.example', 'content-type': 'application/json' }, { sessionId: SESSION }), params);
    expect(res.status).toBe(200);
    expect(confirmStripe).toHaveBeenCalledWith(TOKEN, SESSION);
  });

  it('refuses another origin, a missing origin, a form post and a malformed id without calling the API', async () => {
    const cases = [
      request({ origin: 'https://evil.example', 'content-type': 'application/json' }, { sessionId: SESSION }),
      request({ 'content-type': 'application/json' }, { sessionId: SESSION }),
      request({ origin: 'https://portal.example', 'content-type': 'application/x-www-form-urlencoded' }, `sessionId=${SESSION}`),
      request({ origin: 'https://portal.example', 'content-type': 'application/json' }, { sessionId: 'pi_123' }),
    ];
    const statuses = [];
    for (const req of cases) statuses.push((await POST(req, params)).status);
    expect(statuses).toEqual([403, 403, 415, 400]);
    expect(confirmStripe).not.toHaveBeenCalled();
  });
});

describe('the checkout CSP with Stripe', () => {
  function directive(csp: string, name: string): string {
    return csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
  }

  it('admits Stripe.js, its frames and its API in both modes', () => {
    for (const mode of ['test', 'live'] as const) {
      const csp = buildCheckoutCsp({ nonce: 'n', provider: 'stripe', mode });
      expect(directive(csp, 'script-src')).toContain('https://js.stripe.com');
      expect(directive(csp, 'frame-src')).toContain('https://js.stripe.com');
      expect(directive(csp, 'frame-src')).toContain('https://hooks.stripe.com');
      expect(directive(csp, 'connect-src')).toContain('https://api.stripe.com');
      expect(csp).not.toContain("'unsafe-inline'");
    }
  });

  it('allows every hosted processor for the token’s mode, and still no sandbox host on a live page', () => {
    expect(CHECKOUT_PAGE_PROVIDERS).toEqual(expect.arrayContaining(['paypal', 'stripe']));
    const live = buildCheckoutCsp({ nonce: 'n', provider: CHECKOUT_PAGE_PROVIDERS, mode: 'live' });
    expect(directive(live, 'script-src')).toContain('https://js.stripe.com');
    expect(directive(live, 'script-src')).toContain('https://www.paypal.com');
    expect(live).not.toContain('sandbox');
    const test = buildCheckoutCsp({ nonce: 'n', provider: CHECKOUT_PAGE_PROVIDERS, mode: 'test' });
    expect(directive(test, 'script-src')).toContain('https://www.sandbox.paypal.com');
  });
});
