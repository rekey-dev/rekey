/**
 * The billing log's record of a provider report that left no row: a charge,
 * a failed charge or a refund Rekey could not store or could not attach to a
 * payment. The webhook is still acknowledged, because a retry would end the
 * same way, so this event is the only place an operator learns the money
 * moved.
 */

import type { NotRecordedReason } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { recordMoneyPathBillingEvent } from '../../billing-log/index.js';
import { MAX_PAYMENT_AMOUNT, type ApplyContext } from './apply-shared.js';

export interface NotRecordedReport {
  applicationId: string;
  providerEventId: string;
  providerPaymentId: string;
  kind: 'charge' | 'failed_charge' | 'refund';
  reason: NotRecordedReason;
  /** The amount exactly as the provider's event carried it: a number of the smallest unit, or the provider's own text. */
  reportedAmount: number | string | null | undefined;
  currency?: string | null | undefined;
  providerRefundId?: string | undefined;
  /** The recorded payment a refused refund names, when there is one. */
  paymentId?: string | undefined;
}

/**
 * @example
 * await logNotRecorded(
 *   { applicationId, providerEventId: 'evt_1', providerPaymentId: 'ch_9', kind: 'refund', reason: 'payment_unknown', reportedAmount: 500, currency: 'usd' },
 *   ctx,
 * );
 */
export async function logNotRecorded(report: NotRecordedReport, ctx: ApplyContext): Promise<void> {
  const currency = report.currency?.toUpperCase();
  const amount = report.reportedAmount;
  const storable = typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount <= MAX_PAYMENT_AMOUNT;
  const subject = report.providerRefundId ?? report.providerPaymentId;
  await recordMoneyPathBillingEvent(
    prisma,
    {
      type: 'payment.not_recorded',
      applicationId: report.applicationId,
      // One provider event can carry several refunds, each refused on its own.
      dedupeKey: `${report.providerEventId}:${report.kind}:${report.reason}:${subject}`.slice(0, 255),
      actor: { type: 'provider', ...(ctx.provider !== undefined && { id: ctx.provider }) },
      ...(ctx.provider !== undefined && /^[A-Za-z0-9_.:-]{1,120}$/.test(ctx.provider) && { provider: ctx.provider }),
      providerEventId: report.providerEventId.slice(0, 255),
      ...(report.paymentId !== undefined && { paymentId: report.paymentId }),
      ...(currency !== undefined && /^[A-Z]{3}$/.test(currency) && { currency }),
      ...(storable && { amount }),
      data: {
        kind: report.kind,
        reason: report.reason,
        providerPaymentId: report.providerPaymentId.slice(0, 255),
        providerRefundId: report.providerRefundId?.slice(0, 255) ?? null,
        reportedAmount: amount === null || amount === undefined ? null : String(amount).slice(0, 40),
      },
    },
    ctx.log,
  );
}
