/**
 * Whether a recorded payment can be refunded through Rekey: the one judgement
 * the refund route makes before it asks a provider, and the one the payment
 * reads report as `refundable` and `refundBlockedReason`.
 */

import type { Prisma } from '@prisma/client';
import type { RefundBlockedReason } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { getModule } from './providers/registry.js';

/** Payment statuses a refund can be recorded against. */
export const REFUNDABLE_STATUSES: readonly string[] = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/**
 * The refunded total a payment carries: a payment marked REFUNDED before the
 * amount was recorded was refunded in full.
 */
export function refundedTotalOf(payment: { status: string; refundedAmount: number; amount: number }): number {
  return payment.status === 'REFUNDED' ? Math.max(payment.refundedAmount, payment.amount) : payment.refundedAmount;
}

/** What of a payment the judgement reads, as a Prisma `select`. */
export const REFUND_JUDGEMENT_SELECT = {
  status: true,
  amount: true,
  refundedAmount: true,
  providerPaymentId: true,
  provider: true,
  subscription: { select: { provider: true } },
  unapplied: { select: { provider: true } },
} satisfies Prisma.PaymentSelect;

export type RefundJudgedPayment = Prisma.PaymentGetPayload<{ select: typeof REFUND_JUDGEMENT_SELECT }>;

export type RefundJudgement =
  | { refundable: true; reason: null; provider: string; providerPaymentId: string; remaining: number }
  | { refundable: false; reason: RefundBlockedReason; provider: string | null };

/**
 * The provider that took a payment: the one recorded on it, else on its
 * unapplied case, else on its subscription.
 */
export function providerOfPayment(payment: Pick<RefundJudgedPayment, 'provider' | 'subscription' | 'unapplied'>): string | null {
  const named = payment.provider ?? payment.unapplied?.provider ?? payment.subscription?.provider ?? null;
  return named === 'unknown' ? null : named;
}

/** The providers that have credentials on an Application, enabled or not. */
export async function configuredProviderNames(applicationId: string): Promise<Set<string>> {
  const rows = await prisma.billingCredentials.findMany({ where: { applicationId }, select: { provider: true } });
  return new Set(rows.map((row) => row.provider));
}

/**
 * Judge one payment. The first check that fails is the reason, in the order a
 * refund request meets them.
 *
 * @example
 * const judged = judgeRefund(payment, await configuredProviderNames(applicationId));
 * if (!judged.refundable) judged.reason; // 'already_refunded'
 */
export function judgeRefund(payment: RefundJudgedPayment, configuredProviders: ReadonlySet<string>): RefundJudgement {
  const provider = providerOfPayment(payment);
  const blocked = (reason: RefundBlockedReason): RefundJudgement => ({ refundable: false, reason, provider });

  if (!REFUNDABLE_STATUSES.includes(payment.status)) return blocked('payment_not_succeeded');
  if (payment.providerPaymentId === null) return blocked('no_provider_charge_id');
  const remaining = payment.amount - refundedTotalOf(payment);
  if (remaining <= 0) return blocked('already_refunded');
  if (provider === null) return blocked('provider_unknown');
  if (!getModule(provider)?.capabilities.refunds) return blocked('provider_cannot_refund');
  if (!configuredProviders.has(provider)) return blocked('provider_not_configured');
  return { refundable: true, reason: null, provider, providerPaymentId: payment.providerPaymentId, remaining };
}
