/**
 * The checkout page's "PayPal said yes": verify it with PayPal and move the
 * session from OPEN to CONFIRMING. It activates and captures nothing. Only
 * PayPal's signed webhooks do, through the unchanged appliers:
 * `BILLING.SUBSCRIPTION.ACTIVATED` for a subscription, and
 * `CHECKOUT.ORDER.APPROVED` (which captures, then fulfils) for a one-time order.
 *
 * What a caller holding the token could try, and what stops it:
 *   - an id from another checkout, Application or mode: the id must be the
 *     one this session created, and PayPal's own record of it must carry
 *     `${applicationId}:${endUserId}` and this session's plan (subscription)
 *     or exact amount and currency (order);
 *   - a subscription id on a one-time session, or the reverse: refused;
 *   - an id the buyer never approved: PayPal must report it approved;
 *   - a sandbox id after the credentials moved to live: the session's mode is
 *     checked first, and PayPal is read through the current credential set.
 *
 * The refusal limit, security events and the compare-and-set to CONFIRMING
 * are shared with every provider (confirm-approval.ts).
 */

import type { PaypalApprovalBody } from '@rekey.dev/shared-types/checkout';
import { getProviderForApplication } from '../providers/index.js';
import type { BillingProvider } from '../providers/types.js';
import { confirmApproval, type ConfirmationSession, type Refusal } from './confirm-approval.js';
import type { EmbeddedSessionMetadata } from './sessions.service.js';
import { orderMismatch } from './order-match.js';

const SUBSCRIPTION_APPROVED = new Set(['APPROVED', 'ACTIVE']);
const ORDER_APPROVED = new Set(['APPROVED', 'COMPLETED']);

/** What the page reports PayPal approved: a subscription, or a one-time order. */
export type PaypalApproval = PaypalApprovalBody;

type Outcome = { status: 'confirming' | 'complete' };

function approvedId(approval: PaypalApproval): { id: string; idKey: 'providerSubscriptionId' | 'providerOrderId' } {
  return 'orderId' in approval
    ? { id: approval.orderId, idKey: 'providerOrderId' }
    : { id: approval.subscriptionId, idKey: 'providerSubscriptionId' };
}

async function verifySubscription(
  provider: BillingProvider,
  id: string,
  expectedCustomId: string,
  meta: EmbeddedSessionMetadata,
): Promise<Refusal | null> {
  if (!provider.getSubscription) return { reason: 'provider_cannot_verify', counted: true };
  const snapshot = await provider.getSubscription(id);
  if (snapshot === null || snapshot.id !== id) return { reason: 'unknown_at_paypal', counted: true };
  if (snapshot.customId !== expectedCustomId) return { reason: 'custom_id_mismatch', counted: true };
  if (meta.providerPlanId === null || snapshot.planId !== meta.providerPlanId) return { reason: 'plan_mismatch', counted: true };
  // Not counted toward the limit: this is the session's own subscription, just
  // not approved (yet), which is what a cancelled PayPal window or a refresh
  // of the return URL looks like. Counting it would let those lock out the
  // genuine approval that follows.
  if (!SUBSCRIPTION_APPROVED.has(snapshot.status)) return { reason: `status_${snapshot.status}`, counted: false };
  return null;
}

async function verifyOrder(
  provider: BillingProvider,
  id: string,
  expectedCustomId: string,
  meta: EmbeddedSessionMetadata,
): Promise<Refusal | null> {
  const expected = meta.expectedCharge;
  if (!provider.getOrder || expected === undefined) return { reason: 'provider_cannot_verify', counted: true };
  const snapshot = await provider.getOrder(id);
  const mismatch = orderMismatch(snapshot, id, expectedCustomId, expected);
  if (mismatch !== null || snapshot === null) return { reason: mismatch ?? 'unknown_at_paypal', counted: true };
  // Not counted, for the same reason as a subscription's: the session's own
  // order, not approved yet. COMPLETED means the webhook already captured it.
  if (!ORDER_APPROVED.has(snapshot.status)) return { reason: `status_${snapshot.status}`, counted: false };
  return null;
}

async function verify(session: ConfirmationSession, approval: PaypalApproval): Promise<Refusal | null> {
  const oneTime = session.kind === 'ONE_TIME';
  if (oneTime !== ('orderId' in approval)) return { reason: 'approval_kind_mismatch', counted: true };
  const { id } = approvedId(approval);
  if (id !== session.providerSessionId) {
    return { reason: oneTime ? 'order_id_mismatch' : 'subscription_id_mismatch', counted: true };
  }
  const provider = await getProviderForApplication(session.application, 'paypal');
  const meta = session.metadata as unknown as EmbeddedSessionMetadata;
  const expectedCustomId = `${session.applicationId}:${session.endUserId}`;
  const refusal = oneTime
    ? await verifyOrder(provider, id, expectedCustomId, meta)
    : await verifySubscription(provider, id, expectedCustomId, meta);
  // Only the session's own not-yet-approved id can still be approved on this page.
  if (refusal !== null && !refusal.counted) {
    return { ...refusal, fix: 'Approve the payment again with the PayPal button on this page, or continue on PayPal.' };
  }
  return refusal;
}

/**
 * @example
 * await confirmPaypalApproval('chk_live_…', { subscriptionId: 'I-BW452GLLEP1G' }); // { status: 'confirming' }
 * await confirmPaypalApproval('chk_live_…', { orderId: '5O190127TN364715T' }); // { status: 'confirming' }
 */
export async function confirmPaypalApproval(token: string, approval: PaypalApproval): Promise<Outcome> {
  const { id, idKey } = approvedId(approval);
  return confirmApproval(token, {
    provider: 'paypal',
    refused: {
      message: 'PayPal does not confirm this approval for this checkout.',
      fix: 'Return to the app you were buying in and start the checkout again.',
    },
    eventIds: { [idKey]: id },
    verify: (session) => verify(session, approval),
  });
}
