/**
 * The checkout and cancel actions' redirects.
 *
 * On an Application whose only provider is inbound-only, a Subscribe click
 * with no provider picked is refused with BILLING_PROVIDER_INBOUND_ONLY. The
 * page's copy for that code ("choose another payment option") is a dead end
 * when there was no picker to choose from, so an automatic pick lands on the
 * "checkout isn't available" copy instead.
 *
 * The cancel redirect names the subscription it cancelled, so the banner
 * describes that one rather than whichever is listed first.
 */

import { describe, expect, it, vi } from 'vitest';
import { RekeyError } from '@rekey.dev/react';

const client: { createCheckout: () => Promise<{ url: string }>; [k: string]: unknown } = {
  createCheckout: async () => ({ url: 'https://pay.example' }),
  cancelSubscription: vi.fn(async () => ({})),
  listBillingProviders: vi.fn(async () => ({
    providers: [{ provider: 'external', capabilities: { checkout: false } }, { provider: 'stripe' }],
  })),
};

vi.mock('@/lib/session', () => ({
  portalClientFor: async () => client,
  getAccessToken: async () => 'at',
  getRefreshToken: async () => null,
  setSession: async () => undefined,
  clearSession: async () => undefined,
}));
vi.mock('@/lib/config', () => ({ getPortalConfig: async () => ({ billingSubject: 'user' }) }));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
vi.mock('@/lib/client-ip', () => ({ API_TIMEOUT_MS: 1000, forwardedClientHeaders: async () => ({}) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { checkoutAction, cancelSubscriptionAction } = await import('@/lib/actions');

const inboundOnly = () =>
  new RekeyError({ code: 'BILLING_PROVIDER_INBOUND_ONLY', message: 'inbound only', status: 400 } as never);

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const m = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}

describe('checkoutAction', () => {

  it('an automatic pick refused as inbound-only shows the checkout-unavailable copy', async () => {
    client.createCheckout = async () => {
      throw inboundOnly();
    };
    const to = await redirectOf(() => checkoutAction('acme', null, form({ planSlug: 'pro' })));
    expect(to).toBe('/acme?error=CHECKOUT_UNAVAILABLE');
  });

  it('a provider the buyer picked keeps the choose-another copy', async () => {
    client.createCheckout = async () => {
      throw inboundOnly();
    };
    const to = await redirectOf(() => checkoutAction('acme', null, form({ planSlug: 'pro', provider: 'stripe' })));
    expect(to).toBe('/acme?error=BILLING_PROVIDER_INBOUND_ONLY');
  });
});

describe('cancelSubscriptionAction', () => {
  it('names the cancelled subscription in the redirect', async () => {
    const to = await redirectOf(() => cancelSubscriptionAction('acme', null, 's_basic'));
    expect(to).toBe('/acme?e=canceled&sub=s_basic');
  });
});
