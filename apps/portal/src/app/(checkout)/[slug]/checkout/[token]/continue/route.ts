/**
 * "Continue on PayPal": a plain link, so it works with scripts blocked. Sends
 * the buyer to the processor's own page for this same order. The API returns
 * only an https URL on the processor's own host; anything else sends the buyer
 * back to the checkout page instead of anywhere a tampered value names.
 */

import { NextResponse } from 'next/server';
import { checkoutFallback } from '@/lib/checkout-api';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
): Promise<NextResponse> {
  const { slug, token } = await params;
  const target = await checkoutFallback(token);
  const page = new URL(`/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(token)}`, req.url);
  const res = NextResponse.redirect(target ?? page, 303);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}
