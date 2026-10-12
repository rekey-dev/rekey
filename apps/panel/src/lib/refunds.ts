/**
 * Refunding a recorded payment: what is left to refund, what a typed amount
 * is sent as, and why the page refuses a refund before the operator tries.
 */

import { refundBlockedMessage } from '@rekey.dev/shared-types';
import type { PaymentRow } from './api';
import { formatMoney } from './format';
import { readTypedPrice } from './money-input';

/** What of a payment has not been refunded, in its smallest unit. Never negative. */
export function refundable(payment: { amount: number; refundedAmount: number }): number {
  return Math.max(0, payment.amount - payment.refundedAmount);
}

/**
 * Why a payment cannot be refunded from here, known before the operator
 * tries, or null when it can. The API judges the payment; this puts its
 * reason in words.
 *
 * @example
 * refundRefusal({ status: 'FAILED', refundBlockedReason: 'payment_not_succeeded', amount: 1900, refundedAmount: 0, currency: 'USD' }, true);
 * // 'This payment failed, so no money was taken and there is nothing to refund.'
 */
export function refundRefusal(
  payment: Pick<PaymentRow, 'status' | 'refundBlockedReason' | 'amount' | 'refundedAmount' | 'currency'>,
  canWrite: boolean,
): string | null {
  const reason = payment.refundBlockedReason;
  if (reason === 'payment_not_succeeded' && payment.status === 'FAILED') {
    return 'This payment failed, so no money was taken and there is nothing to refund.';
  }
  if (reason === 'payment_not_succeeded' && payment.status === 'PENDING') {
    return 'This payment has not settled yet. It can be refunded once the provider confirms it.';
  }
  if (reason === 'already_refunded' && payment.refundedAmount >= payment.amount) {
    return `This payment has been refunded in full: ${formatMoney(payment.refundedAmount, payment.currency)} of ${formatMoney(payment.amount, payment.currency)}. Nothing remains.`;
  }
  if (reason !== null) return refundBlockedMessage(reason);
  if (!canWrite) return 'Your access to this Application does not include billing changes, so you can read refunds and not issue one.';
  return null;
}

export type RefundAmountRead =
  /** `amount` undefined means "everything that remains": the API works out the remainder itself. */
  | { ok: true; amount: number | undefined }
  | { ok: false; code: 'refundAmount' | 'refundExceeds'; message: string };

/**
 * A typed refund amount, in the payment's currency, as the smallest unit the
 * API takes. An empty field refunds everything that remains. More than what
 * remains is refused here, with the figure, before the provider is asked.
 *
 * @example
 * readRefundAmount('5', 'USD', 1900);    // { ok: true, amount: 500 }
 * readRefundAmount('', 'USD', 1900);     // { ok: true, amount: undefined }
 * readRefundAmount('500', 'JPY', 300);   // { ok: false, code: 'refundExceeds', ... }
 * readRefundAmount('5.5', 'JPY', 1500);  // { ok: false, code: 'refundAmount', ... }
 */
export function readRefundAmount(raw: string, currency: string, remaining: number): RefundAmountRead {
  if (raw.trim() === '') return { ok: true, amount: undefined };
  const typed = readTypedPrice(raw, currency);
  if (!typed.ok) return { ok: false, code: 'refundAmount', message: typed.message };
  if (typed.minor > remaining) {
    return {
      ok: false,
      code: 'refundExceeds',
      message: `That is more than the ${formatMoney(remaining, currency)} that has not been refunded.`,
    };
  }
  return { ok: true, amount: typed.minor };
}

export const VERIFICATION_COPY: Record<PaymentRow['verification'], { label: string; tone: 'success' | 'warning'; meaning: string }> = {
  verified: {
    label: 'verified',
    tone: 'success',
    meaning: 'This charge matched what was being sold, so it counts as revenue.',
  },
  unverified: {
    label: 'unverified',
    tone: 'warning',
    meaning:
      'The provider took this charge and Rekey could not match it to what a subscription pays, so nothing was granted for it and it is not counted as revenue. Apply it to a subscription from Unapplied payments to verify it, or refund it.',
  },
};
