/**
 * Stripe on the Rekey-hosted checkout page: Checkout Sessions in
 * `ui_mode: 'elements'` with the Payment Element, and the read-back the
 * page's "paid" check relies on (the hosted fallback is in
 * `stripe-hosted-fallback.ts`). The purchase arguments are the redirect flow's own, from
 * `stripe-session-params.ts`, so trials, discounts and payment methods
 * cannot drift between the two presentations.
 */

import type Stripe from 'stripe';
import { STRIPE_RETURN_PARAM } from '@rekey.dev/shared-types';
import { RekeyError } from '../../../lib/error.js';
import { paymentPurchase, stripePriceIdFor, subscriptionPurchase, type PurchaseParams } from './stripe-session-params.js';
import type { CheckoutSessionInput, EmbeddedCheckoutInput, ProviderCheckoutSessionSnapshot } from './types.js';

type Discounts = Stripe.Checkout.SessionCreateParams.Discount[] | undefined;

const PUBLISHABLE_KEY_FIX =
  'Enter the publishable key (pk_test_… or pk_live_…, same mode as the secret key) in Panel → Application → Billing → Setup → Providers → Stripe → Edit.';

/**
 * The publishable key the page initialises Stripe.js with, or the named
 * refusal. Readiness check 6 fails without it, so a checkout only reaches
 * this when the key was removed after the guard ran.
 *
 * @example
 * const pk = requirePublishableKey(creds.publishableKey);
 */
export function requirePublishableKey(publishableKey: string | undefined): string {
  if (publishableKey !== undefined && publishableKey.startsWith('pk_')) return publishableKey;
  throw new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_EMBEDDED_NOT_READY',
    message: 'The Stripe publishable key is missing, so the checkout page cannot load the payment form.',
    fix: PUBLISHABLE_KEY_FIX,
  });
}

/**
 * The page URL with the placeholder Stripe fills in on redirect. The braces
 * must reach Stripe unencoded, so this is string concatenation, not `URL`.
 *
 * @example
 * stripeReturnUrl('https://portal.rekey.dev/acme/checkout/chk_test_…');
 * // 'https://portal.rekey.dev/acme/checkout/chk_test_…?stripe_session_id={CHECKOUT_SESSION_ID}'
 */
export function stripeReturnUrl(pageUrl: string): string {
  return `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}${STRIPE_RETURN_PARAM}={CHECKOUT_SESSION_ID}`;
}

export function clientReference(input: CheckoutSessionInput): string {
  return `${input.application.id}:${input.endUser.id}`;
}

export function purchaseFor(input: CheckoutSessionInput, kind: 'recurring' | 'one_time', priceId: string | null, discounts: Discounts): PurchaseParams {
  return kind === 'recurring' ? subscriptionPurchase(input, priceId ?? stripePriceIdFor(input), discounts) : paymentPurchase(input, discounts);
}

/**
 * The `checkout.sessions.create` arguments for the Rekey page: the redirect
 * flow's purchase, `ui_mode: 'elements'`, and a `return_url` back to the page
 * instead of `success_url` / `cancel_url`, which that mode refuses.
 *
 * @example
 * await stripe.checkout.sessions.create(embeddedSessionParams(input, 'price_123', undefined));
 */
export function embeddedSessionParams(
  input: EmbeddedCheckoutInput,
  priceId: string | null,
  discounts: Discounts,
): Stripe.Checkout.SessionCreateParams {
  return {
    ...purchaseFor(input, input.kind, priceId, discounts),
    ui_mode: 'elements',
    return_url: stripeReturnUrl(input.returnUrl),
    client_reference_id: clientReference(input),
  };
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'resource_missing';
}

/**
 * Stripe's own account of one Checkout Session, or null when Stripe has none.
 *
 * @example
 * const snapshot = await retrieveCheckoutSnapshot(stripe, 'cs_test_…');
 */
export async function retrieveCheckoutSnapshot(
  stripe: Stripe,
  sessionId: string,
): Promise<ProviderCheckoutSessionSnapshot | null> {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  const meta = session.metadata ?? {};
  return {
    id: session.id,
    status: session.status ?? 'unknown',
    paymentStatus: session.payment_status,
    clientReferenceId: session.client_reference_id,
    amountTotal: session.amount_total,
    currency: session.currency === null ? null : session.currency.toUpperCase(),
    url: session.url,
    metadata: {
      applicationId: meta.applicationId ?? null,
      endUserId: meta.endUserId ?? null,
      planId: meta.planId ?? null,
    },
  };
}
