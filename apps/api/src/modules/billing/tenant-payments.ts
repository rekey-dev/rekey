/**
 * A payment as its operator reads it: the shape the payments list and the
 * single payment read both return, and what either costs to build.
 */

import type { Prisma } from '@prisma/client';
import { REFUND_BLOCKED_REASONS, type TenantPaymentDto } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { REFUND_JUDGEMENT_SELECT, configuredProviderNames, judgeRefund } from './refund-eligibility.js';
import { paymentNotFound } from './refunds.service.js';

export const TENANT_PAYMENT_SELECT = {
  ...REFUND_JUDGEMENT_SELECT,
  id: true,
  endUserId: true,
  subscriptionId: true,
  currency: true,
  verification: true,
  description: true,
  createdAt: true,
} satisfies Prisma.PaymentSelect;

type TenantPaymentRow = Prisma.PaymentGetPayload<{ select: typeof TENANT_PAYMENT_SELECT }>;

const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

export const TENANT_PAYMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    endUserId: { type: 'string', nullable: true },
    subscriptionId: { type: 'string', nullable: true },
    amount: { type: 'integer' },
    currency: { type: 'string' },
    status: { type: 'string', enum: [...PAYMENT_STATUSES] },
    refundedAmount: {
      type: 'integer',
      description: 'Cumulative amount refunded so far, smallest currency unit.',
    },
    verification: {
      type: 'string',
      enum: ['verified', 'unverified'],
      description:
        '`unverified` for a charge that was recorded and not applied: it matched no subscription, or not the price it was for. It is in no revenue figure.',
    },
    provider: {
      type: 'string',
      nullable: true,
      description:
        'The provider that took the payment: the one recorded on the payment, else on its unapplied case, else on its subscription. Null when Rekey has no record of one.',
    },
    refundable: {
      type: 'boolean',
      description:
        'Whether a refund request for this payment would reach its provider. The same judgement `POST .../payments/{paymentId}/refunds` makes before it asks one. The provider can still refuse.',
    },
    refundBlockedReason: {
      type: 'string',
      nullable: true,
      enum: [...REFUND_BLOCKED_REASONS, null],
      description:
        'Why the payment cannot be refunded through Rekey. Null exactly when `refundable` is true. ' +
        '`payment_not_succeeded`: pending or failed, nothing was collected. `no_provider_charge_id`: no provider charge id was recorded. ' +
        '`already_refunded`: all of it has been refunded. `provider_unknown`: no record of which provider took it. ' +
        '`provider_cannot_refund`: Rekey cannot issue refunds through that provider. ' +
        '`provider_not_configured`: that provider has no credentials on this Application now.',
    },
    providerPaymentId: { type: 'string', nullable: true },
    description: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    endUserEmail: {
      type: 'string',
      nullable: true,
      description: 'Joined from EndUser; null when the payment is not attributable to one.',
    },
  },
  required: [
    'id',
    'amount',
    'currency',
    'status',
    'refundedAmount',
    'verification',
    'provider',
    'refundable',
    'refundBlockedReason',
    'createdAt',
    'endUserEmail',
  ],
} as const;

/**
 * Payment rows as the operator API returns them. Two queries whatever the
 * number of rows: the payers' emails and the Application's providers.
 *
 * @example
 * const rows = await prisma.payment.findMany({ where: { applicationId }, select: TENANT_PAYMENT_SELECT });
 * const payments = await toTenantPayments(applicationId, rows);
 */
export async function toTenantPayments(applicationId: string, rows: readonly TenantPaymentRow[]): Promise<TenantPaymentDto[]> {
  if (rows.length === 0) return [];
  // Payment has no relation to EndUser, so the email is a second bounded query.
  const userIds = [...new Set(rows.map((row) => row.endUserId).filter((id): id is string => id !== null))];
  const [users, configured] = await Promise.all([
    userIds.length === 0
      ? []
      : prisma.endUser.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }),
    configuredProviderNames(applicationId),
  ]);
  const emailById = new Map(users.map((user) => [user.id, user.email]));
  return rows.map((row) => {
    const judged = judgeRefund(row, configured);
    return {
      id: row.id,
      endUserId: row.endUserId,
      subscriptionId: row.subscriptionId,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      refundedAmount: row.refundedAmount,
      verification: row.verification === 'VERIFIED' ? 'verified' : 'unverified',
      provider: judged.provider,
      refundable: judged.refundable,
      refundBlockedReason: judged.reason,
      providerPaymentId: row.providerPaymentId,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      endUserEmail: row.endUserId === null ? null : (emailById.get(row.endUserId) ?? null),
    };
  });
}

/**
 * One payment of one Application, or `PAYMENT_NOT_FOUND`.
 *
 * @example
 * const payment = await getTenantPayment(application.id, 'pay_1');
 * payment.refundable; // false
 * payment.refundBlockedReason; // 'already_refunded'
 */
export async function getTenantPayment(applicationId: string, paymentId: string): Promise<TenantPaymentDto> {
  const row = await prisma.payment.findFirst({ where: { id: paymentId, applicationId }, select: TENANT_PAYMENT_SELECT });
  if (row === null) throw paymentNotFound(applicationId, paymentId);
  const [payment] = await toTenantPayments(applicationId, [row]);
  if (payment === undefined) throw paymentNotFound(applicationId, paymentId);
  return payment;
}
