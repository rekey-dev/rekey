/**
 * The pricing flow the docs show for Next.js: a client scoped with
 * `visitorCountryHint()` reads the plans this visitor would be charged for
 * and opens the checkout. Pinned here: where the country travels, that the
 * removed `x-country` header is never sent, and that the plans go into
 * `<PricingTable>` as the API returned them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Rekey, priceFallbackMessage, type PublicPlanDto } from '@rekey.dev/node';
import type { PricingTableProps } from '@rekey.dev/react';

let requestHeaders = new Headers();

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

const server = await import('../src/server.js');

const fetchImpl = vi.fn();

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sentHeaders(call = 0): Headers {
  return new Headers((fetchImpl.mock.calls[call]![1] as RequestInit).headers as HeadersInit);
}

const PLAN: PublicPlanDto = {
  id: 'plan_1',
  slug: 'pro',
  name: 'Pro',
  kind: 'SUBSCRIPTION',
  interval: 'MONTH',
  isFree: false,
  trialDays: null,
  licenseKind: null,
  licenseSeatsAllowed: null,
  licenseDurationDays: null,
  meterSlug: null,
  creditsAmount: null,
  price: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'country', requestedCurrency: null },
  prices: [
    { id: 'pp_usd', currency: 'USD', amount: 1900, countries: [], isDefault: true, archived: false },
    { id: 'pp_inr', currency: 'INR', amount: 149900, countries: ['IN'], isDefault: false, archived: false },
  ],
  checkout: { ready: true },
};

beforeEach(() => {
  fetchImpl.mockReset();
  requestHeaders = new Headers({ host: 'app.example', 'x-vercel-ip-country': 'in' });
});

function scopedClient(hint: string | undefined): Rekey {
  const rekey = new Rekey({ apiUrl: 'https://api.test.invalid', secretKey: 'rp_test_x', fetch: fetchImpl });
  return rekey.with({ visitorCountryHint: hint });
}

describe('a pricing page and checkout scoped to the visitor', () => {
  it('reads the plans with the platform country as a hint and the buyer token', async () => {
    fetchImpl.mockResolvedValue(ok({ items: [PLAN], page: { total: 1, limit: 50, offset: 0, hasMore: false } }));
    const scoped = scopedClient(await server.visitorCountryHint());
    const { items } = await scoped.billing.getPlans(undefined, { accessToken: 'jwt.user.token' });

    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.test.invalid/api/v1/billing/plans');
    expect(sentHeaders().get('x-rekey-visitor-country-hint')).toBe('IN');
    expect(sentHeaders().get('x-rekey-user-token')).toBe('jwt.user.token');
    expect(sentHeaders().has('x-country')).toBe(false);

    // What the API returned is what the table takes.
    const props: PricingTableProps = { plans: items, checkoutUrl: '/checkout' };
    expect(props.plans[0]!.price?.formatted).toBe('₹1,499.00');
  });

  it('opens the checkout through the same client and gets the fallback to show the buyer', async () => {
    const fallback = {
      requested: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
      charged: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00' },
      reason: 'no_provider_for_currency' as const,
    };
    fetchImpl.mockResolvedValue(ok({ url: 'https://pay.example/c/1', priceFallback: fallback }));
    const scoped = scopedClient(await server.visitorCountryHint());
    const checkout = await scoped.billing.createCheckout('jwt.user.token', {
      planSlug: 'pro',
      successUrl: 'https://yourapp.com/billing?status=ok',
      cancelUrl: 'https://yourapp.com/billing?status=cancel',
    });

    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    expect(sentHeaders().get('x-rekey-visitor-country-hint')).toBe('IN');
    expect(sentHeaders().has('x-country')).toBe(false);
    expect(priceFallbackMessage(checkout.priceFallback!)).toBe('Prices in INR are not available yet. You will pay $19.00.');
  });

  it('sends no country at all when the platform names none', async () => {
    requestHeaders = new Headers({ host: 'app.example', 'cf-ipcountry': 'XX' });
    fetchImpl.mockResolvedValue(ok({ items: [], page: { total: 0, limit: 50, offset: 0, hasMore: false } }));
    await scopedClient(await server.visitorCountryHint()).billing.getPlans();

    expect(sentHeaders().has('x-rekey-visitor-country-hint')).toBe(false);
    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain('country=');
  });
});
