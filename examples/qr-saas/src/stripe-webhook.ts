/**
 * Drive the REAL signed Stripe webhook path against the local ReliPay API.
 *
 * The stub billing provider creates a PENDING subscription at checkout but
 * issues NO inbound webhook (there's no real Stripe to call us back). To flip
 * PENDING → ACTIVE and provision entitlements, we synthesise the matching
 * `checkout.session.completed` event and sign it offline with the same HMAC
 * the verifier checks — exactly as apps/api/test/stripe-webhook.test.ts does.
 */

import Stripe from 'stripe';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

/**
 * POST a signed `checkout.session.completed` to the per-app Stripe webhook
 * endpoint, flipping the PENDING subscription (matched by checkoutSessionId)
 * to ACTIVE and provisioning its plan entitlements.
 */
export async function completeCheckoutViaWebhook(args: {
  apiUrl: string;
  appSlug: string;
  webhookSecret: string;
  applicationId: string;
  checkoutSessionId: string;
  /** Optional fake provider subscription id to persist on the row. */
  providerSubId?: string;
}): Promise<{ status: number; body: unknown }> {
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: args.checkoutSessionId,
        subscription: args.providerSubId ?? `sub_${Math.random().toString(36).slice(2, 10)}`,
        metadata: { applicationId: args.applicationId },
      },
    },
  };
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: args.webhookSecret });

  const res = await fetch(`${args.apiUrl}/api/v1/billing/webhook/stripe/${args.appSlug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
