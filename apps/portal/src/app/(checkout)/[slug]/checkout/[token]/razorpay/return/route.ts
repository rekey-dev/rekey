/**
 * Where Razorpay Hosted Checkout, the one-time fallback, sends the buyer back.
 *
 * Razorpay POSTs the form here from its own origin, so there is no same-origin
 * check: the fields are only a claim, and the API checks Razorpay's signature
 * on them like any approval. The buyer lands back on the page with the
 * outcome: `paid` (the API confirmed, or could not be asked) makes the page
 * wait for the webhook; `unconfirmed` (the API refused, or refuses any more)
 * shows the do-not-pay-again message, never a Pay button, since Razorpay may
 * have charged; `failed` (Razorpay posts error fields) says nothing was
 * charged. An expired or mode-moved session gets no flag: the page says it
 * expired.
 *
 * The Location is relative, so the browser resolves it against the public
 * URL rather than the internal bind address a proxied `req.url` carries.
 */

import { NextResponse } from 'next/server';
import { parseRazorpayResponse } from '@rekey.dev/shared-types/checkout';
import { confirmRazorpayPayment } from '@/lib/checkout-razorpay-api';
import { RAZORPAY_RETURN_PARAM, type RazorpayReturn } from '@/lib/checkout-razorpay-return';

export const dynamic = 'force-dynamic';

/** API answers after which the buyer must not be offered the Pay button again. */
const NOT_CONFIRMED = new Set(['CHECKOUT_CONFIRMATION_REFUSED', 'CHECKOUT_CONFIRMATION_LIMIT']);

function fromApi(result: { status: number; body: { error?: string } }): RazorpayReturn | null {
  if (result.status === 200 || result.status >= 500) return 'paid';
  return NOT_CONFIRMED.has(result.body.error ?? '') ? 'unconfirmed' : null;
}

async function outcome(form: FormData | null, token: string): Promise<RazorpayReturn | null> {
  if (form === null) return null;
  const response = parseRazorpayResponse({
    paymentId: form.get('razorpay_payment_id') ?? undefined,
    signature: form.get('razorpay_signature') ?? undefined,
    orderId: form.get('razorpay_order_id') ?? undefined,
  });
  if (response !== null) {
    return fromApi(await confirmRazorpayPayment(token, response));
  }
  return form.has('error[code]') ? 'failed' : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
): Promise<NextResponse> {
  const { slug, token } = await params;
  const returned = await outcome(await req.formData().catch(() => null), token);
  const page = `/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(token)}`;
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: returned === null ? page : `${page}?${RAZORPAY_RETURN_PARAM}=${returned}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
