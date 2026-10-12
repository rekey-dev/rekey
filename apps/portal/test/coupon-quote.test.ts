/**
 * The coupon quote call: what it sends, and how each answer is read.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUPON_QUOTE } from './fixtures/billing';

const { RekeyBrowserClient } = await import('@rekey.dev/react');
const { couponCodeOf, isCouponRefusal, quoteCoupon } = await import('@/lib/coupon-quote');

function answer(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function client(): InstanceType<typeof RekeyBrowserClient> {
  return new RekeyBrowserClient({
    apiUrl: 'https://api.example',
    publishableKey: 'rp_pub_x',
    fetch: (input, init) => fetch(input, init),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('quoteCoupon', () => {
  it('asks as the buyer, with the plan and the organization the checkout will bill', async () => {
    const fetchMock = answer(200, { success: true, data: COUPON_QUOTE });
    const result = await quoteCoupon(client(), 'user-token', { code: 'SPRING15', planSlug: 'pro', organizationId: 'org_1' });

    expect(result).toEqual({ kind: 'quote', code: 'SPRING15', quote: COUPON_QUOTE });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example/api/v1/billing/coupons/validate');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'SPRING15', planSlug: 'pro', organizationId: 'org_1' });
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer rp_pub_x');
    expect(headers.get('x-rekey-user-token')).toBe('user-token');
    expect(headers.has('x-country')).toBe(false);
  });

  it("carries a coupon refusal's own message and never its operator-facing fix", async () => {
    answer(400, {
      success: false,
      error: {
        code: 'COUPON_CURRENCY_NOT_COVERED',
        message: 'Coupon "SPRING15" does not work for prices in INR.',
        fix: 'The operator can make this code work in INR by PATCH /api/v1/tenant/applications/:id/coupons/:code.',
      },
    });
    expect(await quoteCoupon(client(), 't', { code: 'SPRING15', planSlug: 'pro' })).toEqual({
      kind: 'refused',
      code: 'SPRING15',
      message: 'Coupon "SPRING15" does not work for prices in INR.',
    });
  });

  it('shows the API sentence when the purchase cannot take a discount, like every other refusal', async () => {
    answer(400, {
      success: false,
      error: {
        code: 'BILLING_DISCOUNT_UNSUPPORTED',
        message: 'A coupon code cannot be used on a recurring subscription here.',
        details: { provider: 'razorpay', flow: 'recurring' },
      },
    });
    expect(await quoteCoupon(client(), 't', { code: 'SPRING15', planSlug: 'pro' })).toEqual({
      kind: 'refused',
      code: 'SPRING15',
      message: 'A coupon code cannot be used on a recurring subscription here.',
    });
  });

  it('reports anything else as unknown, so the buyer is not told the code is bad', async () => {
    answer(401, { success: false, error: { code: 'USER_TOKEN_INVALID', message: 'expired' } });
    expect(await quoteCoupon(client(), 't', { code: 'X', planSlug: 'pro' })).toEqual({ kind: 'unavailable', code: 'X' });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
    expect(await quoteCoupon(client(), 't', { code: 'X', planSlug: 'pro' })).toEqual({ kind: 'unavailable', code: 'X' });
  });
});

describe('coupon helpers', () => {
  it('reads a typed code, and nothing from a blank, repeated or over-long one', () => {
    expect(couponCodeOf(' SPRING15 ')).toBe('SPRING15');
    expect(couponCodeOf('   ')).toBeNull();
    expect(couponCodeOf(['A', 'B'])).toBeNull();
    expect(couponCodeOf('x'.repeat(41))).toBeNull();
    expect(couponCodeOf(undefined)).toBeNull();
  });

  it('knows which refusals are about the code', () => {
    expect(isCouponRefusal('COUPON_EXPIRED')).toBe(true);
    expect(isCouponRefusal('BILLING_DISCOUNT_UNSUPPORTED')).toBe(true);
    expect(isCouponRefusal('BILLING_CURRENCY_CONFLICT')).toBe(false);
    expect(isCouponRefusal(undefined)).toBe(false);
  });
});
