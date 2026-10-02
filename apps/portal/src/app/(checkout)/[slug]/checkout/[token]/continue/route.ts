/**
 * "Continue on {provider}": a plain link, so it works with scripts blocked. Sends
 * the buyer to the processor's own page for this same order. The API returns
 * only an https URL on the processor's own host; anything else sends the buyer
 * back to the checkout page instead of anywhere a tampered value names.
 */

import { NextResponse } from 'next/server';
import { checkoutFallback } from '@/lib/checkout-api';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
): Promise<NextResponse> {
  const { slug, token } = await params;
  const target = await checkoutFallback(token);
  // Relative, so a proxied `req.url`'s internal bind address never leaks into it.
  const page = `/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(token)}`;
  return new NextResponse(null, {
    status: 303,
    headers: { Location: target ?? page, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
