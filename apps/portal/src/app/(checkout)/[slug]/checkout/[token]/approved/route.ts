/**
 * PayPal's `onApprove`, forwarded to the API, which checks it with PayPal and
 * moves the session to "confirming". Nothing is activated here.
 *
 * Same-origin JSON only: a request whose Origin is not this portal is refused
 * before the API is called, so another site cannot drive the confirmation
 * even with a leaked link.
 */

import { NextResponse } from 'next/server';
import { confirmApproval } from '@/lib/checkout-api';
import { portalBaseUrl } from '@/lib/env';

export const dynamic = 'force-dynamic';

const SUBSCRIPTION_ID = /^[A-Za-z0-9-]{1,64}$/;

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
  const body = (await req.json().catch(() => null)) as { subscriptionId?: unknown } | null;
  const subscriptionId = body?.subscriptionId;
  if (typeof subscriptionId !== 'string' || !SUBSCRIPTION_ID.test(subscriptionId)) {
    return NextResponse.json({ error: 'body' }, { status: 400 });
  }
  const { token } = await params;
  const result = await confirmApproval(token, subscriptionId);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
