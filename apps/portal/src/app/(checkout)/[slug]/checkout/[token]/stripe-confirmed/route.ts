/**
 * Stripe's `confirm()` succeeded in the browser: forwarded to the API, which
 * checks the Checkout Session with Stripe and moves the session to
 * "confirming". Nothing is activated here.
 *
 * Same-origin JSON only, like the PayPal approval route: another site cannot
 * drive the confirmation even with a leaked link.
 */

import { NextResponse } from 'next/server';
import { confirmStripe } from '@/lib/checkout-api';
import { portalBaseUrl } from '@/lib/env';
import { STRIPE_CHECKOUT_SESSION_ID_PATTERN } from '@rekey.dev/shared-types/checkout';

export const dynamic = 'force-dynamic';

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && origin === new URL(portalBaseUrl()).origin;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; token: string }> },
): Promise<NextResponse> {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'origin' }, { status: 403 });
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) {
    return NextResponse.json({ error: 'content-type' }, { status: 415 });
  }
  const body = (await req.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = body?.sessionId;
  if (typeof sessionId !== 'string' || !STRIPE_CHECKOUT_SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: 'body' }, { status: 400 });
  }
  const { token } = await params;
  const result = await confirmStripe(token, sessionId);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
