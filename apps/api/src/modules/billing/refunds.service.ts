/**
 * Refunds: the one place a `Refund` row is written.
 *
 * Every refund has a row, whoever started it: a provider's webhook, an
 * operator through the API, or the resolution of an unapplied payment.
 * `payments.refunded_amount` is the sum of a payment's refund rows that have
 * not failed, recomputed in the transaction that writes the row, under a lock
 * on the payment. A provider's refund id is unique per Application, so the
 * webhook that reports a refund Rekey itself issued finds the row and adds
 * nothing.
 */

import type { Application, Prisma, Refund, RefundInitiator, RefundStatus } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { recordMoneyPathBillingEvent, type BillingLogLogger } from '../billing-log/index.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { enqueuePaymentEvent } from './webhooks/billing-events.js';
import type { BillingProviderName } from './credentials.service.js';
import {
  REFUND_JUDGEMENT_SELECT,
  configuredProviderNames,
  judgeRefund,
  refundedTotalOf,
  type RefundJudgement,
} from './refund-eligibility.js';

type Db = Prisma.TransactionClient;

/** A payment row held `FOR UPDATE` for the length of the caller's transaction. */
export interface LockedPayment {
  id: string;
  applicationId: string;
  endUserId: string | null;
  subscriptionId: string | null;
  planPriceId: string | null;
  amount: number;
  refundedAmount: number;
  status: string;
  currency: string;
  provider: string | null;
  providerPaymentId: string | null;
  metadata: Record<string, unknown>;
}

interface PaymentRow {
  id: string;
  application_id: string;
  end_user_id: string | null;
  subscription_id: string | null;
  plan_price_id: string | null;
  amount: number;
  refunded_amount: number;
  status: string;
  currency: string;
  provider: string | null;
  provider_payment_id: string | null;
  metadata: unknown;
}

function toLocked(row: PaymentRow): LockedPayment {
  const metadata = row.metadata;
  return {
    id: row.id,
    applicationId: row.application_id,
    endUserId: row.end_user_id,
    subscriptionId: row.subscription_id,
    planPriceId: row.plan_price_id,
    amount: row.amount,
    refundedAmount: row.refunded_amount,
    status: row.status,
    currency: row.currency,
    provider: row.provider,
    providerPaymentId: row.provider_payment_id,
    metadata:
      typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
  };
}

/**
 * Lock one payment of one Application so two refunds cannot both read the old
 * total. Named by Rekey's id or by the provider's.
 *
 * @example
 * const payment = await lockPaymentForRefund(tx, { applicationId, providerPaymentId: 'in_1' });
 */
export async function lockPaymentForRefund(
  tx: Db,
  where: { applicationId: string } & ({ paymentId: string } | { providerPaymentId: string }),
): Promise<LockedPayment | null> {
  const rows =
    'paymentId' in where
      ? await tx.$queryRaw<PaymentRow[]>`
          SELECT id, application_id, end_user_id, subscription_id, plan_price_id, amount, refunded_amount,
                 status::text AS status, currency, provider, provider_payment_id, metadata
            FROM payments
           WHERE application_id = ${where.applicationId} AND id = ${where.paymentId}
             FOR UPDATE`
      : await tx.$queryRaw<PaymentRow[]>`
          SELECT id, application_id, end_user_id, subscription_id, plan_price_id, amount, refunded_amount,
                 status::text AS status, currency, provider, provider_payment_id, metadata
            FROM payments
           WHERE application_id = ${where.applicationId} AND provider_payment_id = ${where.providerPaymentId}
             FOR UPDATE`;
  const row = rows[0];
  return row === undefined ? null : toLocked(row);
}

/** One refund as its source reported it. `amount` is in the payment's currency, smallest unit. */
export interface RefundFact {
  /** The provider's id for the refund. Null only when the provider's event names none. */
  providerRefundId: string | null;
  amount: number;
  status: RefundStatus;
  /** The operator's own words. Kept on the row, never written to the billing log. */
  reason: string | null;
  initiatedBy: RefundInitiator;
  /** The operator who asked, for an operator refund. */
  actorId?: string | undefined;
  /** The provider event that reported it, for a provider refund. */
  providerEventId?: string | undefined;
}

export type RefundWriteOutcome =
  | { kind: 'recorded'; refund: Refund; total: number; deliveryIds: string[] }
  /** The provider's refund id already has a row. Its status was brought up to date and nothing was added. */
  | { kind: 'known'; refund: Refund; total: number; deliveryIds: string[] }
  | { kind: 'over'; total: number; current: number };

function countedSum(rows: ReadonlyArray<Pick<Refund, 'amount' | 'status'>>): number {
  return rows.reduce((sum, row) => (row.status === 'FAILED' ? sum : sum + row.amount), 0);
}

function statusFor(total: number, payment: LockedPayment): 'SUCCEEDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' {
  if (total <= 0) return 'SUCCEEDED';
  return total >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}

const ACTOR_OF: Record<RefundInitiator, 'operator' | 'provider' | 'system'> = {
  OPERATOR: 'operator',
  PROVIDER: 'provider',
  SYSTEM: 'system',
};

/** A failed refund stays failed, and a settled one is not put back to pending. */
function nextStatus(current: RefundStatus, reported: RefundStatus): RefundStatus {
  if (current === 'FAILED') return 'FAILED';
  if (current === 'SUCCEEDED' && reported === 'PENDING') return 'SUCCEEDED';
  return reported;
}

/**
 * Write one refund against a payment the caller holds locked, set the
 * payment's refunded total from its refund rows, and log it.
 *
 * A refund that would take the total past the payment is refused: nothing is
 * written and the caller says why. A failed refund is recorded and counts for
 * nothing.
 *
 * @example
 * await prisma.$transaction(async (tx) => {
 *   const payment = await lockPaymentForRefund(tx, { applicationId, providerPaymentId: 'in_1' });
 *   if (payment === null) return;
 *   await writeRefund(tx, payment, { providerRefundId: 're_1', amount: 500, status: 'SUCCEEDED',
 *     reason: null, initiatedBy: 'PROVIDER', providerEventId: 'evt_1' });
 * });
 */
export async function writeRefund(
  tx: Db,
  payment: LockedPayment,
  fact: RefundFact,
  log?: BillingLogLogger,
): Promise<RefundWriteOutcome> {
  const rows = await tx.refund.findMany({ where: { paymentId: payment.id } });
  const countedBefore = countedSum(rows);
  // Money an earlier build recorded as refunded with no row to show for it.
  const unexplained = Math.max(0, refundedTotalOf(payment) - countedBefore);
  const current = countedBefore + unexplained;

  const known =
    fact.providerRefundId === null
      ? null
      : await tx.refund.findUnique({
          where: {
            applicationId_providerRefundId: { applicationId: payment.applicationId, providerRefundId: fact.providerRefundId },
          },
        });
  if (known !== null) {
    const status = nextStatus(known.status, fact.status);
    if (known.paymentId !== payment.id || status === known.status) {
      return { kind: 'known', refund: known, total: current, deliveryIds: [] };
    }
    const refund = await tx.refund.update({ where: { id: known.id }, data: { status } });
    const total = countedSum(rows.map((row) => (row.id === refund.id ? refund : row))) + unexplained;
    await tx.payment.update({
      where: { id: payment.id },
      data: { refundedAmount: total, status: statusFor(total, payment) },
    });
    return { kind: 'known', refund, total, deliveryIds: [] };
  }

  const counts = fact.status !== 'FAILED';
  if (counts && current + fact.amount > payment.amount) {
    return { kind: 'over', total: current + fact.amount, current };
  }
  const refund = await tx.refund.create({
    data: {
      applicationId: payment.applicationId,
      paymentId: payment.id,
      providerRefundId: fact.providerRefundId,
      amount: fact.amount,
      currency: payment.currency.toUpperCase(),
      status: fact.status,
      reason: fact.reason,
      initiatedBy: fact.initiatedBy,
    },
  });
  if (!counts) return { kind: 'recorded', refund, total: current, deliveryIds: [] };

  const total = current + fact.amount;
  await tx.payment.update({
    where: { id: payment.id },
    data: { refundedAmount: total, status: statusFor(total, payment) },
  });
  // The money has already gone back at the provider, so an event its schema
  // refuses must not undo the row that says so.
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'payment.refunded',
      applicationId: payment.applicationId,
      dedupeKey: `payment.refunded:${fact.providerEventId ?? 'rekey'}:${refund.id}`,
      actor: { type: ACTOR_OF[fact.initiatedBy], ...(fact.actorId !== undefined && { id: fact.actorId }) },
      ...(payment.endUserId !== null && { endUserId: payment.endUserId }),
      ...(payment.subscriptionId !== null && { subscriptionId: payment.subscriptionId }),
      paymentId: payment.id,
      refundId: refund.id,
      ...(payment.planPriceId !== null && { planPriceId: payment.planPriceId }),
      ...(payment.provider !== null && { provider: payment.provider }),
      ...(fact.providerEventId !== undefined && { providerEventId: fact.providerEventId }),
      currency: refund.currency,
      amount: refund.amount,
      data: {
        refundedAmount: refund.amount,
        totalRefunded: total,
        providerRefundId: refund.providerRefundId,
        initiatedBy: ACTOR_OF[fact.initiatedBy],
        reasonCode: null,
      },
    },
    log,
  );
  const deliveryIds = await enqueuePaymentEvent(tx, 'payment.refunded', payment.id, refund);
  return { kind: 'recorded', refund, total, deliveryIds };
}

/** A refund as the operator API returns it. */
export interface RefundDto {
  id: string;
  paymentId: string;
  providerRefundId: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  reason: string | null;
  initiatedBy: 'operator' | 'provider' | 'system';
  createdAt: string;
}

const STATUS_OUT = { PENDING: 'pending', SUCCEEDED: 'succeeded', FAILED: 'failed' } as const;

/**
 * @example
 * toRefundDto(row); // { id: 'rf_1', amount: 500, currency: 'USD', status: 'succeeded', initiatedBy: 'operator', … }
 */
export function toRefundDto(row: Refund): RefundDto {
  return {
    id: row.id,
    paymentId: row.paymentId,
    providerRefundId: row.providerRefundId,
    amount: row.amount,
    currency: row.currency,
    status: STATUS_OUT[row.status],
    reason: row.reason,
    initiatedBy: ACTOR_OF[row.initiatedBy],
    createdAt: row.createdAt.toISOString(),
  };
}

export interface IssueRefundInput {
  application: Application;
  paymentId: string;
  /** Smallest currency unit. Omitted, everything that has not been refunded. */
  amount?: number | undefined;
  reason?: string | undefined;
  actorId: string;
  /**
   * What makes two requests the same refund at the provider. Left out, it is
   * derived from the payment, what was already refunded and the amount, so a
   * repeated click is one refund and a second partial refund is another.
   */
  idempotencyKey?: string | undefined;
  log?: FastifyBaseLogger | undefined;
}

export interface IssuedRefund {
  refund: RefundDto;
  payment: { id: string; amount: number; currency: string; refundedAmount: number; status: string };
}

function notRefundable(message: string, fix: string): RekeyError {
  return new RekeyError({ statusCode: 409, code: 'BILLING_PAYMENT_NOT_REFUNDABLE', message, fix });
}

/**
 * @example
 * throw paymentNotFound(application.id, 'pay_missing'); // 404 PAYMENT_NOT_FOUND
 */
export function paymentNotFound(applicationId: string, paymentId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'PAYMENT_NOT_FOUND',
    message: `No payment "${paymentId}" in this Application.`,
    fix: `List payments with GET /api/v1/tenant/applications/${applicationId}/payments and use an \`id\` from it.`,
  });
}

const REFUND_IN_DASHBOARD = 'Refund it in the provider dashboard directly.';

/** The refusal a refund request gets for a payment judged not refundable. */
async function refundBlocked(
  application: Application,
  payment: { id: string; status: string },
  judged: Extract<RefundJudgement, { refundable: false }>,
): Promise<RekeyError> {
  switch (judged.reason) {
    case 'payment_not_succeeded':
      return notRefundable(
        `This payment is ${payment.status}, and only a payment that succeeded can be refunded.`,
        'Nothing was collected for it, so there is nothing to pay back.',
      );
    case 'no_provider_charge_id':
      return notRefundable(
        'This payment has no provider charge id, so Rekey cannot ask anyone to refund it.',
        REFUND_IN_DASHBOARD,
      );
    case 'already_refunded':
      return new RekeyError({
        statusCode: 409,
        code: 'BILLING_PAYMENT_ALREADY_REFUNDED',
        message: 'This payment has already been refunded in full.',
        fix: `Nothing to do. GET /api/v1/tenant/applications/${application.id}/payments/${payment.id}/refunds lists the refunds.`,
      });
    case 'provider_unknown':
      return notRefundable(
        'Rekey has no record of which provider took this payment, so it cannot ask one to refund it.',
        REFUND_IN_DASHBOARD,
      );
    case 'provider_cannot_refund':
      return new RekeyError({
        statusCode: 409,
        code: 'BILLING_REFUND_UNSUPPORTED',
        message: `Rekey cannot issue refunds through ${judged.provider}.`,
        fix: REFUND_IN_DASHBOARD,
      });
    case 'provider_not_configured': {
      const { credentialsNotConfigured } = await import('./providers/index.js');
      return credentialsNotConfigured(application, judged.provider as BillingProviderName);
    }
  }
}

export const refundsService = {
  /**
   * Ask the provider to pay money back for one recorded payment, then record
   * the refund. The provider is asked first: a refund row never exists for
   * money that did not move.
   *
   * @example
   * const { refund, payment } = await refundsService.issue({ application, paymentId: 'pay_1', amount: 500, actorId: operator.id });
   * payment.refundedAmount; // 500
   */
  async issue(input: IssueRefundInput): Promise<IssuedRefund> {
    const { application } = input;
    const payment = await prisma.payment.findFirst({
      where: { id: input.paymentId, applicationId: application.id },
      select: { ...REFUND_JUDGEMENT_SELECT, id: true, currency: true, metadata: true },
    });
    if (payment === null) throw paymentNotFound(application.id, input.paymentId);
    const judged = judgeRefund(payment, await configuredProviderNames(application.id));
    if (!judged.refundable) throw await refundBlocked(application, payment, judged);
    const { remaining, providerPaymentId, provider: providerName } = judged;
    if (input.amount !== undefined && input.amount > remaining) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_REFUND_AMOUNT_EXCEEDED',
        message: `Only ${remaining} ${payment.currency.toUpperCase()} (smallest unit) of this payment has not been refunded.`,
        fix: 'Lower `amount`, or omit it to refund everything that remains.',
      });
    }
    const { getProviderForApplication } = await import('./providers/index.js');
    const provider = await getProviderForApplication(application, providerName as BillingProviderName);
    // The module declares refunds; the instance is what gets called.
    if (!provider.refundPayment) {
      throw await refundBlocked(application, payment, { refundable: false, reason: 'provider_cannot_refund', provider: providerName });
    }

    const storedHref = (payment.metadata as { refundHref?: unknown } | null)?.refundHref;
    const result = await provider.refundPayment({
      providerPaymentId,
      ...(input.amount !== undefined && { amount: input.amount }),
      currency: payment.currency,
      ...(input.reason !== undefined && { reason: input.reason }),
      idempotencyKey:
        input.idempotencyKey ?? `rekey-refund-${payment.id}-${payment.refundedAmount}-${input.amount ?? 'rest'}`,
      ...(typeof storedHref === 'string' && { refundHref: storedHref }),
    });

    const written = await prisma.$transaction(async (tx) => {
      const locked = await lockPaymentForRefund(tx, { applicationId: application.id, paymentId: payment.id });
      if (locked === null) return null;
      const outcome = await writeRefund(
        tx,
        locked,
        {
          providerRefundId: result.refundId,
          // A provider that does not echo the amount refunded what was asked
          // for: the amount named, or everything that remained.
          amount: result.amount > 0 ? result.amount : (input.amount ?? remaining),
          status: result.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING',
          reason: input.reason ?? null,
          initiatedBy: 'OPERATOR',
          actorId: input.actorId,
        },
        input.log,
      );
      const after = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: { id: true, amount: true, currency: true, refundedAmount: true, status: true },
      });
      return { outcome, after };
    });
    if (written === null) {
      throw notRefundable(
        'The payment was deleted while the provider was refunding it.',
        `The provider refund ${result.refundId} went through. Find it in the ${providerName} dashboard; Rekey holds no row for it.`,
      );
    }
    if (written.outcome.kind === 'over') {
      // The provider refunded more than Rekey believed was left: its record of
      // this payment is ahead of ours. The refund is real and is not recorded.
      input.log?.error(
        { paymentId: payment.id, providerRefundId: result.refundId, total: written.outcome.total },
        'refund issued at the provider exceeds what Rekey had recorded as remaining; not recorded',
      );
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_REFUND_EXCEEDS_PAYMENT',
        message: `${providerName} refunded ${result.amount} ${payment.currency.toUpperCase()} (refund ${result.refundId}), which with the ${written.outcome.current} already recorded is more than the payment of ${payment.amount}.`,
        fix: `The refund went through at ${providerName} and was not recorded here. Compare this payment's refunds in the ${providerName} dashboard with GET /api/v1/tenant/applications/${application.id}/payments/${payment.id}/refunds.`,
      });
    }
    kickDeliveries(written.outcome.deliveryIds);
    return { refund: toRefundDto(written.outcome.refund), payment: written.after };
  },

  /**
   * One page of a payment's refunds, oldest first.
   *
   * @example
   * const { items, page } = await refundsService.listForPayment(application.id, 'pay_1', { limit: 50, offset: 0 });
   */
  async listForPayment(
    applicationId: string,
    paymentId: string,
    window: { limit: number; offset: number },
  ): Promise<{ items: RefundDto[]; page: { total: number; limit: number; offset: number; hasMore: boolean } }> {
    const payment = await prisma.payment.findFirst({ where: { id: paymentId, applicationId }, select: { id: true } });
    if (payment === null) throw paymentNotFound(applicationId, paymentId);
    const where = { paymentId, applicationId };
    const [rows, total] = await Promise.all([
      prisma.refund.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: window.limit, skip: window.offset }),
      prisma.refund.count({ where }),
    ]);
    return {
      items: rows.map(toRefundDto),
      page: { total, limit: window.limit, offset: window.offset, hasMore: window.offset + window.limit < total },
    };
  },
};
