/**
 * Swap a Stripe elements session for a hosted one, for the checkout page's
 * "Continue on Stripe" link. An elements session has no hosted URL of its own.
 */

import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { RekeyError } from '../../../lib/error.js';
import { clientReference, purchaseFor, stripeReturnUrl } from './stripe-embedded.js';
import type { CheckoutSessionResult, HostedFallbackInput } from './types.js';

type Discounts = Stripe.Checkout.SessionCreateParams.Discount[] | undefined;

/** Stripe refuses an `expires_at` under 30 minutes away; one more covers the round trip. */
export const MIN_HOSTED_LIFETIME_MS = 31 * 60 * 1000;
const KEY_IN_USE_RETRY_MS = 1_000;

function alreadyPaid(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_SESSION_COMPLETE',
    message: 'This checkout is already paid, or its payment is being processed.',
    fix: 'Return to the app you were buying in. The purchase completes when Stripe confirms the payment, which for a bank debit can take a few business days. Do not pay again.',
  });
}

function tooLate(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_FALLBACK_UNAVAILABLE',
    message: "This checkout expires in under half an hour, too soon to open Stripe's own page for it.",
    fix: 'Pay with the form on this page, or return to the app you were buying in and start the checkout again.',
  });
}

/**
 * Close the embedded session at Stripe. Only an `open` session can be
 * expired; one that is already expired (an earlier attempt got this far) is
 * fine, and one that completed meanwhile is refused as paid.
 */
async function closeEmbedded(stripe: Stripe, session: Stripe.Checkout.Session): Promise<void> {
  if (session.status !== 'open') return;
  try {
    await stripe.checkout.sessions.expire(session.id);
  } catch (e) {
    const now = await stripe.checkout.sessions.retrieve(session.id);
    if (now.status === 'complete') throw alreadyPaid();
    if (now.status !== 'expired') throw e;
  }
}

/**
 * The embedded session's discount, carried over as-is. The coupon was minted
 * for this checkout with `max_redemptions: 1`, and the embedded session that
 * held it is expired unredeemed, so the hosted session can take it.
 */
function carriedDiscounts(session: Stripe.Checkout.Session): Discounts {
  const discounts = (session.discounts ?? []).flatMap((d): Stripe.Checkout.SessionCreateParams.Discount[] => {
    const coupon = typeof d.coupon === 'string' ? d.coupon : d.coupon?.id;
    if (coupon) return [{ coupon }];
    const promotionCode = typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code?.id;
    return promotionCode ? [{ promotion_code: promotionCode }] : [];
  });
  return discounts.length > 0 ? discounts : undefined;
}

/**
 * The hosted session's arguments: what the embedded session charged, not
 * what the plan says now. A subscription keeps the price id it was created
 * with; a one-time purchase keeps the embedded session's pre-discount amount
 * and currency.
 */
function hostedParams(input: HostedFallbackInput, embedded: Stripe.Checkout.Session): Stripe.Checkout.SessionCreateParams {
  const plan =
    input.kind === 'one_time' && embedded.amount_subtotal !== null && embedded.currency !== null
      ? { ...input.plan, amount: embedded.amount_subtotal, currency: embedded.currency }
      : input.plan;
  return {
    ...purchaseFor({ ...input, plan }, input.kind, input.priceId, carriedDiscounts(embedded)),
    client_reference_id: clientReference(input),
    success_url: stripeReturnUrl(input.successUrl),
    cancel_url: input.cancelUrl,
    expires_at: Math.floor(input.expiresAt.getTime() / 1000),
  };
}

/**
 * The replacement's key plus a digest of its arguments. A retry with the same
 * arguments gets Stripe's stored answer, the same hosted session; a retry
 * whose arguments changed (the buyer's email was edited in between) gets a
 * new session instead of Stripe's `idempotency_error`, and the earlier one,
 * whose URL never reached the buyer, stays unreachable.
 */
function idempotencyKeyFor(input: HostedFallbackInput, params: Stripe.Checkout.SessionCreateParams): string {
  const digest = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
  return `${input.idempotencyKey}-${digest}`;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

async function createOnce(
  stripe: Stripe,
  params: Stripe.Checkout.SessionCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Checkout.Session> {
  try {
    return await stripe.checkout.sessions.create(params, { idempotencyKey });
  } catch (e) {
    // A concurrent click is creating the same session under the same key;
    // once it finishes, Stripe replays its answer to this one.
    if (errorCode(e) !== 'idempotency_key_in_use') throw e;
    await new Promise((r) => setTimeout(r, KEY_IN_USE_RETRY_MS));
    return stripe.checkout.sessions.create(params, { idempotencyKey });
  }
}

/**
 * Order matters: the embedded session is expired BEFORE the hosted one is
 * created, so at no moment can the buyer pay both, and the hosted session
 * expires with the Rekey checkout, so it never outlives the coupon and trial
 * reservations held for it. Every refusal happens before the embedded
 * session is touched.
 *
 * @example
 * const { url } = await replaceWithHostedSession(stripe, { ...input, kind: 'recurring', embeddedSessionId, idempotencyKey, priceId, expiresAt });
 */
export async function replaceWithHostedSession(stripe: Stripe, input: HostedFallbackInput): Promise<CheckoutSessionResult> {
  const embedded = await stripe.checkout.sessions.retrieve(input.embeddedSessionId);
  if (embedded.metadata?.applicationId !== input.application.id) {
    throw new Error('Stripe session does not belong to this Application.');
  }
  if (embedded.status === 'complete') throw alreadyPaid();
  if (input.expiresAt.getTime() - Date.now() < MIN_HOSTED_LIFETIME_MS) throw tooLate();
  const params = hostedParams(input, embedded);
  await closeEmbedded(stripe, embedded);
  const hosted = await createOnce(stripe, params, idempotencyKeyFor(input, params));
  if (!hosted.url) throw new Error('Stripe returned a hosted checkout session without a `url`.');
  return { sessionId: hosted.id, url: hosted.url };
}
