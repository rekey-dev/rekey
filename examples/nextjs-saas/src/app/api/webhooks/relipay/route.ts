/**
 * POST /api/webhooks/rekey — receive webhooks Rekey sends to YOUR app.
 *
 * Covers the auth lifecycle events (user.created, …) and the billing events
 * (subscription.activated / canceled / past_due, payment.succeeded / failed).
 * See docs/billing.md "Webhooks Rekey sends to YOUR app".
 *
 * Two rules every handler must follow:
 *   1. Verify the signature against the RAW request bytes — any
 *      reserialization breaks the HMAC.
 *   2. Dedupe on `eventId`: a delivery that times out on your side is
 *      retried by Rekey, so the same event can arrive more than once.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { verifyWebhookSignature, type WebhookEventEnvelope } from '@rekey.dev/node';

// Demo-only dedupe store. In production use something durable shared across
// instances (a unique-keyed DB table or Redis SETNX) — this Set resets on
// restart and isn't shared between replicas.
const seenEventIds = new Set<string>();

export async function POST(req: NextRequest): Promise<Response> {
  const payload = await req.text(); // raw body — do NOT use req.json() before verifying

  const ok = verifyWebhookSignature({
    header: req.headers.get('x-rekey-signature'),
    payload,
    secret: process.env.RELIPAY_WEBHOOK_SECRET ?? '',
  });
  if (!ok) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  const event = JSON.parse(payload) as WebhookEventEnvelope;

  if (seenEventIds.has(event.eventId)) {
    // Already processed — acknowledge so Rekey stops retrying.
    return NextResponse.json({ received: true, duplicate: true });
  }
  seenEventIds.add(event.eventId);

  switch (event.type) {
    case 'subscription.activated':
      // e.g. provision access, refresh cached entitlements for the user
      break;
    case 'subscription.past_due':
    case 'subscription.canceled':
      // e.g. schedule a downgrade, notify the customer
      break;
    case 'payment.failed':
      // e.g. alert your support channel
      break;
    default:
      // Unhandled event types are fine — acknowledge and move on.
      break;
  }

  return NextResponse.json({ received: true });
}
