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

type ProviderRow = { provider: string; currencies?: string[]; capabilities?: { checkout: boolean } };

const ENABLED: ProviderRow[] = [
  { provider: 'external', capabilities: { checkout: false } },
  { provider: 'stripe' },
  { provider: 'razorpay', currencies: ['INR'] },
];
/** Which providers the API says can charge each plan. An unlisted plan filters nothing. */
const CHARGEABLE: Record<string, string[]> = { pro_usd: ['stripe'], pro_inr: ['stripe', 'razorpay'] };

const client: {
  createCheckout: (token: string, input: Record<string, unknown>) => Promise<{ url: string }>;
  [k: string]: unknown;
} = {
  createCheckout: async () => ({ url: 'https://pay.example' }),
  cancelSubscription: vi.fn(async () => ({})),
  listBillingProviders: vi.fn(async (opts?: { planSlug?: string }) => {
    const can = opts?.planSlug === undefined ? undefined : CHARGEABLE[opts.planSlug];
    return { providers: can === undefined ? ENABLED : ENABLED.filter((p) => can.includes(p.provider)) };
  }),
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

describe('checkoutAction, a provider that cannot charge the plan', () => {
  /** The checkout input the action sent for this form. */
  async function posted(fields: Record<string, string>): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> | undefined;
    client.createCheckout = async (_token, input) => {
      sent = input;
      return { url: 'https://pay.example' };
    };
    expect(await redirectOf(() => checkoutAction('acme', null, form(fields)))).toBe('https://pay.example');
    return sent!;
  }

  it('posts the picked provider with a plan it can charge', async () => {
    expect(await posted({ planSlug: 'pro_inr', provider: 'razorpay' })).toMatchObject({ planSlug: 'pro_inr', provider: 'razorpay' });
    expect(await posted({ planSlug: 'pro_usd', provider: 'stripe' })).toMatchObject({ provider: 'stripe' });
  });

  it('posts no provider when the buyer left the picker on the one it preselected', async () => {
    const sent = await posted({ planSlug: 'pro_inr', provider: 'razorpay', providerPreselected: 'razorpay' });
    expect(sent.planSlug).toBe('pro_inr');
    expect('provider' in sent).toBe(false);
    // Changed from the preselected one, it is a choice and is posted.
    expect(await posted({ planSlug: 'pro_inr', provider: 'razorpay', providerPreselected: 'stripe' })).toMatchObject({
      provider: 'razorpay',
    });
  });

  it('posts no provider with a plan the pick cannot charge, so the API routes it', async () => {
    const sent = await posted({ planSlug: 'pro_usd', provider: 'razorpay' });
    expect(sent.planSlug).toBe('pro_usd');
    expect('provider' in sent).toBe(false);
  });

  it('keeps the pick when the per-plan list cannot be read', async () => {
    const list = client.listBillingProviders as ReturnType<typeof vi.fn>;
    const real = list.getMockImplementation()!;
    list.mockImplementation(async (opts?: { planSlug?: string }) => {
      if (opts?.planSlug !== undefined) throw new Error('older API');
      return real(opts);
    });
    try {
      expect(await posted({ planSlug: 'pro_usd', provider: 'razorpay' })).toMatchObject({ provider: 'razorpay' });
    } finally {
      list.mockImplementation(real);
    }
  });

  it('still refuses a pick the Application does not offer at all', async () => {
    const to = await redirectOf(() => checkoutAction('acme', null, form({ planSlug: 'pro_usd', provider: 'mollie' })));
    expect(to).toBe('/acme?error=BILLING_PROVIDER_NOT_AVAILABLE');
  });
});

describe('checkoutAction, a coupon code', () => {
  const refusal = (code: string) => new RekeyError({ code, message: 'refused', status: 400 } as never);

  it('sends a code the plan page had priced, and no field when there is none', async () => {
    const sent: Array<Record<string, unknown>> = [];
    client.createCheckout = async (_token, input) => {
      sent.push(input);
      return { url: 'https://pay.example' };
    };
    await redirectOf(() => checkoutAction('acme', null, form({ planSlug: 'pro', couponCode: ' SPRING15 ' })));
    await redirectOf(() => checkoutAction('acme', null, form({ planSlug: 'pro' })));
    expect(sent[0]).toMatchObject({ planSlug: 'pro', couponCode: 'SPRING15' });
    expect('couponCode' in sent[1]!).toBe(false);
  });

  it('returns a code the checkout refuses to the plan page, where full price can still be paid', async () => {
    for (const code of ['COUPON_CURRENCY_NOT_COVERED', 'COUPON_EXPIRED', 'BILLING_DISCOUNT_UNSUPPORTED']) {
      client.createCheckout = async () => {
        throw refusal(code);
      };
      const to = await redirectOf(() => checkoutAction('acme', null, form({ planSlug: 'pro', couponCode: 'SPRING 15' })));
      expect(to).toBe('/acme/plans/pro?coupon=SPRING%2015&refused=1');
    }
  });

  it('sends a refusal that is not about the code to the dashboard', async () => {
    client.createCheckout = async () => {
      throw refusal('BILLING_CURRENCY_CONFLICT');
    };
    const to = await redirectOf(() => checkoutAction('acme', null, form({ planSlug: 'pro', couponCode: 'SPRING15' })));
    expect(to).toBe('/acme?error=BILLING_CURRENCY_CONFLICT');
  });
});

describe('cancelSubscriptionAction', () => {
  it('names the cancelled subscription in the redirect', async () => {
    const to = await redirectOf(() => cancelSubscriptionAction('acme', null, 's_basic', form({})));
    expect(to).toBe('/acme?e=canceled&sub=s_basic');
  });

  it('passes on a reason the customer chose, and drops one that is not a known reason', async () => {
    const cancel = vi.fn(async () => ({}));
    client.cancelSubscription = cancel;
    await redirectOf(() => cancelSubscriptionAction('acme', null, 's_basic', form({ reason: 'too_expensive' })));
    await redirectOf(() => cancelSubscriptionAction('acme', null, 's_basic', form({ reason: 'made_up' })));
    expect(cancel.mock.calls.map((c) => (c as unknown as [string, { reason?: string }])[1].reason)).toEqual(['too_expensive', undefined]);
  });
});
