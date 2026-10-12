/**
 * `visitorClient` forwards the visitor's address and User-Agent, so the API
 * rate-limits the visitor rather than this server and the session records the
 * visitor's browser rather than this server's runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { priceFallbackMessage } from '@rekey.dev/node';
import { visitorClient, visitorCountryHintFrom } from '../src/index.js';

function ok(): Response {
  return new Response(JSON.stringify({ success: true, data: { mfaRequired: false } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('visitorClient', () => {
  const fetchImpl = vi.fn();

  beforeEach(() => {
    process.env.REKEY_SECRET = 'rp_test_visitor';
    process.env.REKEY_URL = 'https://api.test.invalid';
    fetchImpl.mockReset().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchImpl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sent(): Headers {
    return new Headers((fetchImpl.mock.calls[0]![1] as RequestInit).headers as HeadersInit);
  }

  it('sends the visitor address and User-Agent', async () => {
    const request = new Request('https://app.example/api/sign-in', {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' },
    });
    await visitorClient({ request, clientAddress: '203.0.113.9' }).auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sent().get('x-rekey-client-ip')).toBe('203.0.113.9');
    expect(sent().get('x-rekey-client-user-agent')).toBe('Mozilla/5.0 (iPhone) Safari/604.1');
  });

  it('forwards the platform country as a hint, on a billing call too', async () => {
    const request = new Request('https://app.example/api/checkout', { headers: { 'cf-ipcountry': 'in' } });
    await visitorClient({ request, clientAddress: '203.0.113.9' }).billing.getProviders();
    expect(sent().get('x-rekey-visitor-country-hint')).toBe('IN');
    // A hint is not a declared country: nothing claims it in `x-country` or the query.
    expect(sent().has('x-country')).toBe(false);
    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain('country=');
  });

  it('reads the plans for this visitor: the hint and the buyer token, and no removed header', async () => {
    const request = new Request('https://app.example/pricing', { headers: { 'x-vercel-ip-country': 'IN' } });
    await visitorClient({ request }).billing.getPlans(undefined, { accessToken: 'jwt.user.token' });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://api.test.invalid/api/v1/billing/plans');
    expect(sent().get('x-rekey-visitor-country-hint')).toBe('IN');
    expect(sent().get('x-rekey-user-token')).toBe('jwt.user.token');
    expect(sent().has('x-country')).toBe(false);
  });

  it('posts a checkout with the currency rule in the body and returns the fallback the buyer must be told about', async () => {
    const fallback = {
      requested: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
      charged: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00' },
      reason: 'no_provider_for_currency',
    };
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { url: 'https://pay.example/c/1', priceFallback: fallback } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const request = new Request('https://app.example/api/checkout', { headers: { 'cf-ipcountry': 'IN' } });
    const input = {
      planSlug: 'pro',
      onUnavailableCurrency: 'fallback' as const,
      successUrl: 'https://app.example/ok',
      cancelUrl: 'https://app.example/cancel',
    };
    const checkout = await visitorClient({ request }).billing.createCheckout('jwt.user.token', input);

    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual(input);
    expect(sent().has('x-country')).toBe(false);
    expect(priceFallbackMessage(checkout.priceFallback!)).toBe('Prices in INR are not available yet. You will pay $19.00.');
  });

  it('falls back to the Vercel header', async () => {
    const request = new Request('https://app.example/api/checkout', { headers: { 'x-vercel-ip-country': 'DE' } });
    await visitorClient({ request }).billing.getProviders();
    expect(sent().get('x-rekey-visitor-country-hint')).toBe('DE');
  });

  it.each(['XX', 'T1', 'IND', ''])('sends no hint when the platform header is %j', async (bad) => {
    const request = new Request('https://app.example/api/checkout', { headers: { 'cf-ipcountry': bad } });
    await visitorClient({ request }).billing.getProviders();
    expect(sent().has('x-rekey-visitor-country-hint')).toBe(false);
    expect(visitorCountryHintFrom(request.headers)).toBeUndefined();
  });

  it('never forwards a hint the visitor wrote in the SDK\'s own header', async () => {
    const request = new Request('https://app.example/api/checkout', {
      headers: { 'x-rekey-visitor-country-hint': 'IN', 'x-country': 'IN' },
    });
    await visitorClient({ request }).billing.getProviders();
    expect(sent().has('x-rekey-visitor-country-hint')).toBe(false);
  });

  it('sends neither when Astro has no address and the request no User-Agent', async () => {
    const request = new Request('https://app.example/api/sign-in');
    const context = {
      request,
      get clientAddress(): string {
        throw new Error('clientAddress is not available');
      },
    };
    await visitorClient(context).auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sent().has('x-rekey-client-ip')).toBe(false);
    expect(sent().has('x-rekey-client-user-agent')).toBe(false);
  });
});
