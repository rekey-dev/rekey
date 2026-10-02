/**
 * The portal's two Razorpay routes. `razorpay/approved` takes the modal's
 * handler response from this page only; `razorpay/return` takes Hosted
 * Checkout's cross-site form post, whose fields are only a claim the API
 * checks. Neither forwards a malformed response.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRazorpayResponse } from '@rekey.dev/shared-types/checkout';

const confirm = vi.fn<(...args: unknown[]) => Promise<{ status: number; body: { status?: string; error?: string } }>>(async () => ({
  status: 200,
  body: { status: 'confirming' },
}));
vi.mock('@/lib/checkout-razorpay-api', () => ({ confirmRazorpayPayment: (...args: unknown[]) => confirm(...args) }));
const fallback = vi.fn<(token: string) => Promise<string | null>>(async () => null);
vi.mock('@/lib/checkout-api', () => ({ checkoutFallback: (t: string) => fallback(t) }));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example' }));

const approved = await import('@/app/(checkout)/[slug]/checkout/[token]/razorpay/approved/route');
const returned = await import('@/app/(checkout)/[slug]/checkout/[token]/razorpay/return/route');
const continued = await import('@/app/(checkout)/[slug]/checkout/[token]/continue/route');

const TOKEN = `chk_test_${'R'.repeat(43)}`;
const params = { params: Promise.resolve({ slug: 'acme', token: TOKEN }) };
const SIG = 'a'.repeat(64);

function json(headers: Record<string, string>, body: unknown): Request {
  return new Request(`https://portal.example/acme/checkout/${TOKEN}/razorpay/approved`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** As the request reaches the app behind the proxy: an internal host in `req.url`. */
function form(fields: Record<string, string>): Request {
  return new Request(`http://0.0.0.0:3050/acme/checkout/${TOKEN}/razorpay/return`, {
    method: 'POST',
    headers: { origin: 'https://api.razorpay.com', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('parseRazorpayResponse', () => {
  it('accepts exactly one of a subscription or an order id, every field well formed', () => {
    expect(parseRazorpayResponse({ paymentId: 'pay_1', signature: SIG, subscriptionId: 'sub_1', orderId: undefined })).toEqual({
      paymentId: 'pay_1',
      signature: SIG,
      subscriptionId: 'sub_1',
    });
    expect(parseRazorpayResponse({ paymentId: 'pay_1', signature: SIG, subscriptionId: undefined, orderId: 'order_1' })).toEqual({
      paymentId: 'pay_1',
      signature: SIG,
      orderId: 'order_1',
    });
    for (const bad of [
      { paymentId: 'pay_1', signature: SIG, subscriptionId: 'sub_1', orderId: 'order_1' },
      { paymentId: 'pay_1', signature: SIG, subscriptionId: undefined, orderId: undefined },
      { paymentId: 'pay_1', signature: 'XYZ', subscriptionId: 'sub_1', orderId: undefined },
      { paymentId: '../x', signature: SIG, subscriptionId: 'sub_1', orderId: undefined },
      { paymentId: 'pay_1', signature: SIG, subscriptionId: 'order_1', orderId: undefined },
    ]) {
      expect(parseRazorpayResponse(bad)).toBeNull();
    }
  });
});

describe('POST …/razorpay/approved', () => {
  beforeEach(() => confirm.mockClear());

  it('forwards a same-origin JSON handler response', async () => {
    const body = { paymentId: 'pay_1', signature: SIG, orderId: 'order_1' };
    const res = await approved.POST(json({ origin: 'https://portal.example', 'content-type': 'application/json' }, body), params);
    expect(res.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(TOKEN, body);
  });

  it('refuses another origin, a form post and a malformed response without calling the API', async () => {
    const ok = { paymentId: 'pay_1', signature: SIG, orderId: 'order_1' };
    const statuses = [];
    for (const req of [
      json({ origin: 'https://evil.example', 'content-type': 'application/json' }, ok),
      json({ 'content-type': 'application/json' }, ok),
      json({ origin: 'https://portal.example', 'content-type': 'application/x-www-form-urlencoded' }, 'a=b'),
      json({ origin: 'https://portal.example', 'content-type': 'application/json' }, { ...ok, subscriptionId: 'sub_1' }),
    ]) {
      statuses.push((await approved.POST(req, params)).status);
    }
    expect(statuses).toEqual([403, 403, 415, 400]);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('POST …/razorpay/return', () => {
  beforeEach(() => confirm.mockClear());
  const PAGE = `/acme/checkout/${TOKEN}`;
  const PAID = { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_signature: SIG };

  it("forwards Hosted Checkout's paid fields and returns to the page, waiting for the webhook", async () => {
    const res = await returned.POST(form(PAID), params);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PAGE}?razorpay=paid`);
    expect(confirm).toHaveBeenCalledWith(TOKEN, { paymentId: 'pay_1', orderId: 'order_1', signature: SIG });
  });

  it('still waits for the webhook when the API could not be asked, since Razorpay said paid', async () => {
    confirm.mockResolvedValueOnce({ status: 502, body: { error: 'unavailable' } });
    expect((await returned.POST(form(PAID), params)).headers.get('location')).toBe(`${PAGE}?razorpay=paid`);
  });

  it.each(['CHECKOUT_CONFIRMATION_REFUSED', 'CHECKOUT_CONFIRMATION_LIMIT'])(
    'marks a payment the API answered %s as unconfirmed, never paid',
    async (error) => {
      confirm.mockResolvedValueOnce({ status: 409, body: { error } });
      expect((await returned.POST(form(PAID), params)).headers.get('location')).toBe(`${PAGE}?razorpay=unconfirmed`);
    },
  );

  it.each([
    [409, 'CHECKOUT_SESSION_EXPIRED'],
    [409, 'CHECKOUT_MODE_MISMATCH'],
    [404, 'not_found'],
  ])('puts no flag on a session the API answered %i %s, which the page shows as expired', async (status, error) => {
    confirm.mockResolvedValueOnce({ status, body: { error } });
    expect((await returned.POST(form(PAID), params)).headers.get('location')).toBe(PAGE);
  });

  it('says a failed payment failed, and ignores anything malformed', async () => {
    const failed = await returned.POST(form({ 'error[code]': 'BAD_REQUEST_ERROR', 'error[description]': 'Payment failed' }), params);
    expect(failed.headers.get('location')).toBe(`${PAGE}?razorpay=failed`);
    const malformed = await returned.POST(form({ ...PAID, razorpay_signature: 'nothex' }), params);
    expect(malformed.headers.get('location')).toBe(PAGE);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never puts the internal host in the Location', async () => {
    const res = await returned.POST(form(PAID), params);
    expect(res.headers.get('location')).not.toContain('0.0.0.0');
    expect(res.headers.get('location')!.startsWith('/')).toBe(true);
  });
});

describe('GET …/continue', () => {
  it("sends the buyer to the provider's page, or back to the checkout page with a relative Location", async () => {
    const req = new Request(`http://0.0.0.0:3050/acme/checkout/${TOKEN}/continue`);
    fallback.mockResolvedValueOnce('https://rzp.io/i/abc');
    expect((await continued.GET(req, params)).headers.get('location')).toBe('https://rzp.io/i/abc');
    fallback.mockResolvedValueOnce(null);
    expect((await continued.GET(req, params)).headers.get('location')).toBe(`/acme/checkout/${TOKEN}`);
  });
});
