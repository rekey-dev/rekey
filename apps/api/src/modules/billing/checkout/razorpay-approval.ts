/**
 * The checkout page's "Razorpay said paid": verify Razorpay's signature on it
 * and move the session from OPEN to CONFIRMING (confirm-approval.ts). It
 * activates nothing. Only Razorpay's signed webhook does
 * (`subscription.activated` / `.authenticated`, or `order.paid`).
 *
 * What a caller holding the token could try, and what stops it here:
 *   - an id from another checkout, Application or mode: the subscription or
 *     order id must be the one this session created, of this session's kind;
 *   - a forged or replayed handler response: the HMAC-SHA256 that Razorpay
 *     signs with the key secret must match, for this payment and this id, in
 *     Razorpay's own field order;
 *   - a real payment for less, or for another order: for an order, Razorpay's
 *     own record of the payment must name this order and the amount and
 *     currency recorded when the checkout was created;
 *   - a sandbox payment after the credentials moved to live: the session's
 *     mode is checked first, and the secret is the current credential set's.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RazorpayPaymentResponse } from '@rekey.dev/shared-types/checkout';
import { billingCredentialsService } from '../credentials.service.js';
import { getProviderForApplication } from '../providers/index.js';
import { confirmApproval, type ConfirmationSession, type Refusal } from './confirm-approval.js';
import type { EmbeddedSessionMetadata } from './sessions.service.js';

type Outcome = { status: 'confirming' | 'complete' };

/** Payment states in which the money is, or is about to be, the operator's. */
const PAID_STATUSES = new Set(['authorized', 'captured']);

/** Not the buyer's doing, so never counted toward their limit. */
const CANNOT_VERIFY: Refusal = {
  reason: 'provider_cannot_verify',
  counted: false,
  message: "Rekey could not check this payment with Razorpay: the Application's Razorpay credentials cannot be read.",
  fix: "Do not pay again. If Razorpay took the payment, it completes from Razorpay's webhook within a few minutes. Otherwise, contact the business you are buying from.",
};

function signedId(response: RazorpayPaymentResponse): { kind: 'subscription' | 'order'; id: string } {
  return 'orderId' in response
    ? { kind: 'order', id: response.orderId }
    : { kind: 'subscription', id: response.subscriptionId };
}

/**
 * Razorpay's documented payloads: `order_id|payment_id` for an order,
 * `payment_id|subscription_id` for a subscription.
 */
function signatureMatches(secret: string, response: RazorpayPaymentResponse): boolean {
  const payload =
    'orderId' in response ? `${response.orderId}|${response.paymentId}` : `${response.paymentId}|${response.subscriptionId}`;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'), 'utf8');
  const given = Buffer.from(response.signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Razorpay's own record of an order payment must be for this order, in full. */
async function verifyOrderPayment(session: ConfirmationSession, paymentId: string): Promise<Refusal | null> {
  const expected = (session.metadata as unknown as Partial<EmbeddedSessionMetadata>).expectedCharge;
  const provider = await getProviderForApplication(session.application, 'razorpay');
  if (expected === undefined || !provider.getPayment || !provider.capturePayment) return CANNOT_VERIFY;
  const payment = await provider.getPayment(paymentId);
  if (payment === null || payment.id !== paymentId) return { reason: 'unknown_at_razorpay', counted: true };
  if (payment.orderId !== session.providerSessionId) return { reason: 'payment_order_mismatch', counted: true };
  if (payment.currency !== expected.currency) return { reason: 'currency_mismatch', counted: true };
  if (payment.amount !== expected.amount) return { reason: 'amount_mismatch', counted: true };
  // Not counted: this session's own payment in a state that can still move
  // (Razorpay signs only successes, so this is a stale read, not a forgery).
  if (!PAID_STATUSES.has(payment.status)) return { reason: `status_${payment.status}`, counted: false };
  // An account set to manual capture leaves the payment authorized, Razorpay
  // never fires `order.paid` for it and refunds it after a few days. Capture
  // it here so the webhook arrives; capturing twice is a no-op at Razorpay.
  if (payment.status === 'authorized') await provider.capturePayment(paymentId, expected.amount, expected.currency);
  return null;
}

async function verify(session: ConfirmationSession, response: RazorpayPaymentResponse): Promise<Refusal | null> {
  const signed = signedId(response);
  const expectedKind = session.kind === 'ONE_TIME' ? 'order' : 'subscription';
  if (signed.kind !== expectedKind) return { reason: 'kind_mismatch', counted: true };
  if (signed.id !== session.providerSessionId) return { reason: `${signed.kind}_id_mismatch`, counted: true };

  const creds = await billingCredentialsService.loadDecrypted(session.applicationId, 'razorpay').catch(() => null);
  const secret = creds?.keySecret;
  if (!secret) return CANNOT_VERIFY;
  if (!signatureMatches(secret, response)) return { reason: 'signature_invalid', counted: true };

  return signed.kind === 'order' ? verifyOrderPayment(session, response.paymentId) : null;
}

/**
 * @example
 * await confirmRazorpayApproval('chk_live_…', { paymentId: 'pay_…', orderId: 'order_…', signature: '9f…' });
 * // { status: 'confirming' }
 */
export async function confirmRazorpayApproval(token: string, response: RazorpayPaymentResponse): Promise<Outcome> {
  const signed = signedId(response);
  return confirmApproval(token, {
    provider: 'razorpay',
    refused: {
      message: 'Razorpay does not confirm this payment for this checkout.',
      fix: "Do not pay again. If Razorpay took the payment, it completes within a few minutes, or Razorpay refunds it. Otherwise, start the checkout again from the app you were buying in.",
    },
    eventIds: { provider: 'razorpay', providerSessionId: signed.id, providerPaymentId: response.paymentId },
    verify: (session) => verify(session, response),
  });
}
