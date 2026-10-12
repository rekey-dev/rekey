/**
 * What a buyer is told about the price before they pay, and the browser
 * client calls that feed it. Fixtures are parsed by the API's own schemas, so
 * a component that reads a field the API does not send fails here.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CheckoutResultDtoSchema,
  PagedSchema,
  PublicPlanDtoSchema,
  ValidateCouponResultDtoSchema,
} from '@rekey.dev/shared-types';
import { CouponQuote, PriceFallbackNotice, PricingTable, RekeyBrowserClient, RekeyError } from '../src/index.js';

const AT = '2026-10-12T09:00:00.000Z';
const FALLBACK = {
  requested: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
  charged: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00' },
  reason: 'no_provider_for_currency' as const,
};
const USD = { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'fallback' as const, requestedCurrency: 'INR' };

const QUOTE = ValidateCouponResultDtoSchema.parse({
  coupon: { code: 'LAUNCH50', discountType: 'PERCENT', basisPoints: 5000 },
  plan: { slug: 'pro', name: 'Pro' },
  price: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'country', requestedCurrency: null },
  priceFallback: null,
  currency: 'INR',
  amount: 149900,
  discountAmount: 75000,
  amountAfterDiscount: 74900,
  formatted: { discount: '₹750.00', total: '₹749.00' },
});

const PLANS = PagedSchema(PublicPlanDtoSchema).parse({
  items: [
    {
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
      price: USD,
      prices: [
        { id: 'pp_usd', currency: 'USD', amount: 1900, countries: [], isDefault: true, archived: false },
        { id: 'pp_inr', currency: 'INR', amount: 149900, countries: ['IN'], isDefault: false, archived: false },
      ],
      checkout: { ready: true },
    },
  ],
  page: { total: 1, limit: 50, offset: 0, hasMore: false },
});

const CHECKOUT = CheckoutResultDtoSchema.parse({
  url: 'https://checkout.example/c/1',
  subscription: {
    id: 'sub_1',
    applicationId: 'app_1',
    endUserId: 'eu_1',
    planId: 'plan_1',
    status: 'PENDING',
    currentPeriodEnd: null,
    cancelAt: null,
    canceledAt: null,
    provider: 'stripe',
    providerSubId: null,
    metadata: {},
    createdAt: AT,
    updatedAt: AT,
    beneficiaryOrgId: null,
    trialEndsAt: null,
    price: null,
  },
  discountAmount: 0,
  currency: 'USD',
  unitAmount: 1900,
  price: USD,
  priceFallback: FALLBACK,
  provider: 'stripe',
  warnings: [],
  mode: 'redirect',
  checkoutSessionId: 'chs_1',
});

describe('<PriceFallbackNotice>', () => {
  it('tells the buyer which currency could not be charged and what they pay', () => {
    render(<PriceFallbackNotice fallback={CHECKOUT.priceFallback} />);
    expect(screen.getByRole('status').textContent).toBe('Prices in INR are not available yet. You will pay $19.00.');
  });

  it('renders nothing when the price selected is the price charged', () => {
    const { container } = render(<PriceFallbackNotice fallback={null} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('takes your own wording', () => {
    render(<PriceFallbackNotice fallback={FALLBACK}>We bill in US dollars for now.</PriceFallbackNotice>);
    expect(screen.getByRole('status').textContent).toBe('We bill in US dollars for now.');
  });
});

describe('<CouponQuote>', () => {
  it('shows what the code takes off and what the buyer pays, as the API wrote them', () => {
    render(<CouponQuote quote={QUOTE} />);
    expect(screen.getByRole('status').textContent).toBe('LAUNCH50 takes ₹750.00 off. You pay ₹749.00.');
  });

  it('says first when the quote is for the default price because theirs cannot be charged', () => {
    const quote = { ...QUOTE, priceFallback: FALLBACK, formatted: { discount: '$9.50', total: '$9.50' } };
    render(<CouponQuote quote={quote} />);
    const lines = screen.getAllByRole('status').map((line) => line.textContent);
    expect(lines).toEqual([
      'Prices in INR are not available yet. You will pay $19.00.',
      'LAUNCH50 takes $9.50 off. You pay $9.50.',
    ]);
  });
});

describe('<PricingTable> with plans as the API returns them', () => {
  it('renders the resolved price and the fallback note from a real plan list', () => {
    const { container } = render(<PricingTable plans={PLANS.items} checkoutUrl="/checkout" />);
    expect(container.querySelector('.rekey-price')!.textContent).toBe('$19.00 /month');
    expect(container.querySelector('.rekey-plan-price-note')!.textContent).toContain('You will pay $19.00.');
  });
});

function client(fetchImpl: typeof fetch): RekeyBrowserClient {
  return new RekeyBrowserClient({ apiUrl: 'https://api.example.com', publishableKey: 'rp_pub_demo', fetch: fetchImpl });
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('RekeyBrowserClient', () => {
  it('validateCoupon posts the quote request with the publishable key and the user token', async () => {
    const spy = vi.fn().mockResolvedValue(ok(QUOTE));
    const request = { code: 'LAUNCH50', planSlug: 'pro', provider: 'razorpay' };
    const quote = await client(spy).validateCoupon('jwt.user.token', request);

    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://api.example.com/api/v1/billing/coupons/validate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(headers.Authorization).toBe('Bearer rp_pub_demo');
    expect(headers['X-Rekey-User-Token']).toBe('jwt.user.token');
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('x-country');
    expect(quote).toEqual(QUOTE);
  });

  it('validateCoupon surfaces a currency refusal as a RekeyError with the message to show', async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'COUPON_CURRENCY_NOT_COVERED', message: 'This code does not work for prices in INR.', fix: 'Continue without the code.' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    const err: unknown = await client(spy).validateCoupon('t', { code: 'FIVEOFF', planSlug: 'pro' }).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(RekeyError);
    expect((err as RekeyError).code).toBe('COUPON_CURRENCY_NOT_COVERED');
    expect((err as RekeyError).message).toBe('This code does not work for prices in INR.');
  });

  it('getPlans sends the buyer token when given one, so a subscriber sees the currency they pay in', async () => {
    const spy = vi.fn().mockImplementation(async () => ok(PLANS));
    await client(spy).getPlans({ limit: 10 }, { accessToken: 'jwt.user.token' });
    await client(spy).getPlans();

    const signedIn = spy.mock.calls[0]! as [string, RequestInit];
    const anonymous = spy.mock.calls[1]! as [string, RequestInit];
    expect(signedIn[0]).toBe('https://api.example.com/api/v1/billing/plans?limit=10');
    expect((signedIn[1].headers as Record<string, string>)['X-Rekey-User-Token']).toBe('jwt.user.token');
    expect(anonymous[0]).toBe('https://api.example.com/api/v1/billing/plans');
    expect((anonymous[1].headers as Record<string, string>)['X-Rekey-User-Token']).toBeUndefined();
  });
});
