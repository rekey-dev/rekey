/**
 * The page's polling endpoint. Same-origin only; the API applies its own
 * per-session rate limit behind it.
 */

import { NextResponse } from 'next/server';
import { checkoutStatus } from '@/lib/checkout-api';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const status = await checkoutStatus(token);
  return NextResponse.json(
    { status: status ?? 'unknown' },
    { status: status === null ? 502 : 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
