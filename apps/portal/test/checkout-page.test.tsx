/**
 * The checkout route's decisions: which state a lookup renders, and that no
 * state but an open one shows the order or the buyer's email. The API client
 * and the request headers are stubbed; the component tree is rendered for real.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutPageView } from '@rekey.dev/shared-types';
import type { CheckoutLookup } from '@/lib/checkout-api';

const lookup = vi.fn<(token: string) => Promise<CheckoutLookup>>();
const confirm = vi.fn(async () => ({ status: 200, body: { status: 'confirming' } }));
vi.mock('@/lib/checkout-api', () => ({
  lookupCheckout: (t: string) => lookup(t),
  confirmApproval: (...args: unknown[]) => confirm(...(args as [])),
  isCheckoutToken: (t: string) => t.startsWith('chk_'),
}));
const redirected = vi.fn((to: string) => {
  throw new Error(`REDIRECT ${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirected(to) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-nonce': 'page-nonce', 'accept-language': 'en-US' }),
}));

const { default: CheckoutPage } = await import('@/app/(checkout)/[slug]/checkout/[token]/page');

const TOKEN = `chk_live_${'D'.repeat(43)}`;
const EMAIL = 'buyer@example.com';

function openView(overrides: Partial<CheckoutPageView> = {}): CheckoutPageView {
  return {
    status: 'open',
    slug: 'acme',
    paymentMode: 'live',
    provider: 'paypal',
    returnUrl: 'https://app.example/account',
    order: {
      merchant: {
        displayName: 'Acme',
        logoUrl: null,
        primaryColor: null,
        backgroundColor: null,
        surfaceColor: null,
        supportEmail: null,
        supportUrl: null,
        termsUrl: null,
        privacyUrl: null,
        refundUrl: null,
      },
      plan: { name: 'Pro', amount: 1000, currency: 'USD', interval: 'MONTH', kind: 'recurring' },
      discountAmount: 0,
      totalDueToday: 1000,
      buyerEmail: EMAIL,
      successUrl: 'https://app.example/ok',
      cancelUrl: 'https://app.example/account',
      manageUrl: null,
      expiresAt: new Date().toISOString(),
      client: { provider: 'paypal', clientId: 'cid', subscriptionId: 'I-1', sdk: 'v5-subscription' },
    },
    ...overrides,
  };
}

async function render(slug = 'acme'): Promise<string> {
  const element = await CheckoutPage({ params: Promise.resolve({ slug, token: TOKEN }) });
  return renderToStaticMarkup(element);
}

describe('checkout route', () => {
  beforeEach(() => lookup.mockReset());

  it('renders the order for an open session', async () => {
    lookup.mockResolvedValue({ kind: 'view', view: openView() });
    const html = await render();
    expect(html).toContain(EMAIL);
    expect(html).toContain('nonce="page-nonce"');
  });

  it('shows no order and no email once complete or expired', async () => {
    for (const status of ['complete', 'expired'] as const) {
      lookup.mockResolvedValue({ kind: 'view', view: openView({ status }) });
      const html = await render();
      expect(html).not.toContain(EMAIL);
      expect(html).not.toContain('$10.00');
    }
  });

  it('answers a session of another Application exactly like an unknown token', async () => {
    lookup.mockResolvedValue({ kind: 'view', view: openView() });
    const wrongSlug = await render('someone-else');
    lookup.mockResolvedValue({ kind: 'not_found' });
    const unknown = await render('someone-else');
    expect(wrongSlug).toBe(unknown);
    expect(wrongSlug).not.toContain(EMAIL);
  });

  it('loads no processor script for a provider this page does not serve', async () => {
    lookup.mockResolvedValue({ kind: 'view', view: openView({ provider: 'razorpay' }) });
    const html = await render();
    expect(html).not.toContain(EMAIL);
    expect(html).toContain('This checkout has expired');
  });

  it('checks a return from PayPal once, then redirects to strip the query so a refresh cannot ask again', async () => {
    lookup.mockResolvedValue({ kind: 'view', view: openView() });
    confirm.mockClear();
    redirected.mockClear();
    await expect(
      CheckoutPage({
        params: Promise.resolve({ slug: 'acme', token: TOKEN }),
        searchParams: Promise.resolve({ subscription_id: 'I-RETURNED1' }),
      }),
    ).rejects.toThrow(`REDIRECT /acme/checkout/${TOKEN}`);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(TOKEN, 'I-RETURNED1');

    confirm.mockClear();
    await expect(
      CheckoutPage({
        params: Promise.resolve({ slug: 'acme', token: TOKEN }),
        searchParams: Promise.resolve({ subscription_id: '../x' }),
      }),
    ).rejects.toThrow('REDIRECT');
    expect(confirm).not.toHaveBeenCalled();

    redirected.mockClear();
    await CheckoutPage({ params: Promise.resolve({ slug: 'acme', token: TOKEN }), searchParams: Promise.resolve({}) });
    expect(redirected).not.toHaveBeenCalled();
  });

  it('treats a mode mismatch as expired', async () => {
    lookup.mockResolvedValue({ kind: 'expired' });
    expect(await render()).toContain('This checkout has expired');
  });

  it('never tells a buyer on an expired or unavailable page that nothing was charged', async () => {
    const lookups: CheckoutLookup[] = [
      { kind: 'expired' },
      { kind: 'unavailable' },
      { kind: 'view', view: openView({ status: 'expired' }) },
    ];
    for (const result of lookups) {
      lookup.mockResolvedValue(result);
      const html = await render();
      expect(html).not.toMatch(/been charged/i);
      expect(html).toMatch(/do not pay again/i);
    }
  });
});
