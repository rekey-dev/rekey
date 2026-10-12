/**
 * The plan review page's reads: the catalogue is asked as the buyer, a code in
 * the address is priced by the API on every render, and a plan that cannot be
 * bought is never reviewed.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicPlanDto, SelfSubscriptionDto } from '@rekey.dev/shared-types';
import type { CouponQuote } from '@/lib/coupon-quote';
import { COUPON_QUOTE, PLANS, subscription } from './fixtures/billing';

const state: { plans: PublicPlanDto[]; held: SelfSubscriptionDto[]; quote: CouponQuote | null } = {
  plans: [PLANS.proInIndia, PLANS.team],
  held: [],
  quote: null,
};
const clientTokens: Array<string | undefined> = [];
const quoted: Array<Record<string, unknown>> = [];
const providerCalls: Array<Record<string, unknown> | undefined> = [];

vi.mock('@/lib/session', () => ({
  getPortalUser: async () => ({ accessToken: 'at' }),
  portalClientFor: async () => {
    return {
      getPlans: async (_page?: unknown, opts?: { accessToken?: string }) => {
        clientTokens.push(opts?.accessToken);
        return { items: state.plans };
      },
      listSubscriptions: async () => ({ items: state.held }),
      listBillingProviders: async (opts?: Record<string, unknown>) => {
        providerCalls.push(opts);
        return { providers: [] };
      },
      listOrganizations: async () => ({ items: [] }),
    };
  },
}));
vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ billingSubject: 'user', billingEnabled: true, branding: {}, publishableKey: 'rp_pub_x' }),
}));
vi.mock('@/lib/actions', () => ({ checkoutAction: async () => undefined }));
vi.mock('@/lib/coupon-quote', async (original) => ({
  ...(await original<typeof import('@/lib/coupon-quote')>()),
  quoteCoupon: async (_client: unknown, _token: string, input: Record<string, unknown>) => {
    quoted.push(input);
    return state.quote;
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { default: PlanReviewPage } = await import('@/app/(portal)/[slug]/plans/[planSlug]/page');

async function render(planSlug: string, searchParams: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await PlanReviewPage({ params: Promise.resolve({ slug: 'acme', planSlug }), searchParams: Promise.resolve(searchParams) }),
  );
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

describe('plan review page', () => {
  beforeEach(() => {
    state.plans = [PLANS.proInIndia, PLANS.team];
    state.held = [];
    state.quote = null;
    clientTokens.length = 0;
    quoted.length = 0;
    providerCalls.length = 0;
  });

  it("reads the catalogue with the buyer's token and the providers for this plan", async () => {
    const html = await render('pro');
    expect(clientTokens).toEqual(['at']);
    expect(providerCalls).toEqual([{ planSlug: 'pro' }]);
    expect(html).toContain('₹1,499.00 /month');
    expect(quoted).toEqual([]);
  });

  it('prices a code from the address with the API, never trusting the address for the outcome', async () => {
    state.quote = { kind: 'quote', code: 'SPRING15', quote: COUPON_QUOTE };
    const html = await render('pro', { coupon: ' SPRING15 ' });
    expect(quoted).toEqual([{ code: 'SPRING15', planSlug: 'pro', organizationId: null }]);
    expect(html).toContain('$16.15');
  });

  it('treats a code the checkout just refused as refused, even when the quote still accepts it', async () => {
    state.quote = { kind: 'quote', code: 'SPRING15', quote: COUPON_QUOTE };
    const html = await render('pro', { coupon: 'SPRING15', refused: '1' });
    expect(html).toContain('This code could not be applied to this checkout.');
    expect(html).not.toContain('name="couponCode"');
    expect(html).toContain('Continue to checkout');
  });

  it('sends a plan that is unknown, already held or not buyable back to the dashboard', async () => {
    expect(await redirectOf(() => render('nope'))).toBe('/acme?error=PLAN_NOT_FOUND');
    expect(await redirectOf(() => render('%E0%A4%A'))).toBe('/acme?error=PLAN_NOT_FOUND');

    state.held = [subscription({ planId: PLANS.team.id })];
    expect(await redirectOf(() => render('team'))).toBe('/acme');

    state.held = [];
    state.plans = [PLANS.proBoundUnchargeable];
    expect(await redirectOf(() => render('pro'))).toBe('/acme?error=PLAN_UNAVAILABLE');
  });
});
