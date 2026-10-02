/**
 * The checkout page's "Stripe took the payment": Stripe's half of
 * `confirmApproval`. It activates nothing; only Stripe's signed
 * `checkout.session.completed` (or `checkout.session.async_payment_succeeded`)
 * webhook does, through the unchanged applier.
 *
 * What a caller holding the token could try, and what stops it:
 *   - a session id from another checkout, Application or mode: the id must be
 *     the one this row holds, and Stripe's own record of it must name this
 *     Application, buyer and plan in its metadata and `client_reference_id`;
 *   - a session the buyer never finished: Stripe must report it `complete`.
 *     Its `payment_status` may be `paid`, `no_payment_required` (a trial) or
 *     `unpaid`: a bank debit (SEPA, ACH, Bacs) completes the session before
 *     the money arrives, and `checkout.session.async_payment_succeeded`
 *     settles it later. Such a session is as committed as a paid one; the
 *     buyer must not be offered the form again;
 *   - a one-time order re-priced since: when the session recorded what it
 *     charges, Stripe's `amount_total` and currency must match it;
 *   - a session replaced by the hosted fallback while Stripe was being asked:
 *     the move to CONFIRMING is pinned to the session id.
 */

import { prisma } from '../../../lib/prisma.js';
import { getProviderForApplication } from '../providers/index.js';
import { confirmApproval, type ApprovalVerifier, type ConfirmationSession, type Refusal } from './confirm-approval.js';
import { expectedChargeOf } from './order-match.js';

async function stripeRefusal(session: ConfirmationSession, checkoutSessionId: string, counted: boolean): Promise<Refusal | null> {
  if (checkoutSessionId !== session.providerSessionId) return { reason: 'session_id_mismatch', counted };
  const provider = await getProviderForApplication(session.application, 'stripe');
  if (!provider.getCheckoutSession) return { reason: 'provider_cannot_verify', counted: false };
  const snapshot = await provider.getCheckoutSession(checkoutSessionId);
  if (snapshot === null || snapshot.id !== checkoutSessionId) return { reason: 'unknown_at_stripe', counted };
  const plan = await prisma.subscription.findUniqueOrThrow({ where: { id: session.subscriptionId }, select: { planId: true } });
  const { metadata } = snapshot;
  if (
    metadata.applicationId !== session.applicationId ||
    metadata.endUserId !== session.endUserId ||
    metadata.planId !== plan.planId ||
    snapshot.clientReferenceId !== `${session.applicationId}:${session.endUserId}`
  ) {
    return { reason: 'metadata_mismatch', counted };
  }
  const expected = expectedChargeOf(session.metadata);
  if (expected !== null && (snapshot.amountTotal !== expected.amount || snapshot.currency !== expected.currency.toUpperCase())) {
    return { reason: 'amount_mismatch', counted };
  }
  // Not counted: this is the session's own Checkout Session, just not
  // finished (yet), which is what a declined card or an abandoned 3-D Secure
  // challenge looks like. Counting it would let those lock out the genuine
  // payment that follows.
  if (snapshot.status !== 'complete') return { reason: `status_${snapshot.status}_${snapshot.paymentStatus}`, counted: false };
  return null;
}

/**
 * `via: 'return'` is the page's own server checking the session Stripe
 * returned the buyer with on a page load. Its refusals are not counted toward
 * the limit, so a stale return link cannot lock out the payment that
 * follows; the per-token rate limit still bounds it.
 *
 * @example
 * stripeVerifier('cs_live_a1B2…', 'page');
 */
export function stripeVerifier(checkoutSessionId: string, via: 'page' | 'return'): ApprovalVerifier {
  return {
    provider: 'stripe',
    refused: {
      message: 'Stripe does not confirm this payment for this checkout.',
      fix: 'Pay again with the form on this page, or continue on Stripe.',
    },
    eventIds: { providerSessionId: checkoutSessionId },
    providerSessionId: checkoutSessionId,
    verify: (session) => stripeRefusal(session, checkoutSessionId, via === 'page'),
  };
}

/**
 * @example
 * await confirmStripePayment('chk_live_…', 'cs_live_a1B2…'); // { status: 'confirming' }
 */
export async function confirmStripePayment(
  token: string,
  checkoutSessionId: string,
  via: 'page' | 'return' = 'page',
): Promise<{ status: 'confirming' | 'complete' }> {
  return confirmApproval(token, stripeVerifier(checkoutSessionId, via));
}
