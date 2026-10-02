/**
 * Razorpay's checkout `handler`, forwarded to the API, which verifies its
 * signature and moves the session to "confirming". Nothing is activated here.
 *
 * Same-origin JSON only, like the PayPal route: a request whose Origin is not
 * this portal is refused before the API is called.
 */

import { NextResponse } from 'next/server';
import { parseRazorpayResponse } from '@rekey.dev/shared-types/checkout';
import { confirmRazorpayPayment } from '@/lib/checkout-razorpay-api';
import { portalBaseUrl } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
): Promise<NextResponse> {
  if (req.headers.get('origin') !== new URL(portalBaseUrl()).origin) {
    return NextResponse.json({ error: 'origin' }, { status: 403 });
  }
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) {
    return NextResponse.json({ error: 'content-type' }, { status: 415 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const response =
    body === null
      ? null
      : parseRazorpayResponse({
          paymentId: body.paymentId,
          signature: body.signature,
          subscriptionId: body.subscriptionId,
          orderId: body.orderId,
        });
  if (response === null) return NextResponse.json({ error: 'body' }, { status: 400 });
  const { token } = await params;
  const result = await confirmRazorpayPayment(token, response);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
