/**
 * Refund applier: a provider said money went back against a recorded payment.
 *
 * Each refund becomes a `Refund` row and a billing event, in one transaction
 * with the payment's new refunded total (see `refunds.service.ts`).
 *
 * Three shapes of news arrive:
 *   - refunds listed with their ids (Stripe's `charge.refunds`): one row per
 *     id, and a row for the rest when the charge's running total is larger
 *     than the listed refunds add up to;
 *   - a running total alone (`refundedTotal`): one row for what the total
 *     grew by, so a refund Rekey issued and then hears about adds nothing;
 *   - one refund amount (`amount`), with or without its id. Without an id the
 *     event id is what stops a redelivery counting twice.
 *
 * A refund that cannot be recorded (no payment on record, a payment that
 * cannot take it, an amount no row can hold) is acknowledged and written to
 * the billing log as `payment.not_recorded`, so an operator sees it.
 *
 * It does not revoke what the payment bought. Clawing back credits, licences
 * and subscriptions is #413. Until then the operator reverses credits with
 * `credits.grant({ reason: 'ADJUST', amount: -n })`, which is audited.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import type { PaymentRefundedEvent, ProviderRefund } from '../providers/module-types.js';
import { REFUNDABLE_STATUSES, refundedTotalOf } from '../refund-eligibility.js';
import { lockPaymentForRefund, writeRefund, type LockedPayment, type RefundFact } from '../refunds.service.js';
import { safeAmount, type ApplyContext } from './apply-shared.js';
import { logNotRecorded } from './not-recorded.js';

/** How many refund event ids a payment remembers, for refunds whose provider names no refund id. */
const REMEMBERED_REFUND_EVENTS = 50;

const STATUS_IN = { pending: 'PENDING', succeeded: 'SUCCEEDED', failed: 'FAILED' } as const;

type RefundOutcome =
  | { kind: 'recorded'; total: number; amount: number; written: number; deliveryIds: string[] }
  | { kind: 'replay' | 'unchanged' | 'unknown' }
  | { kind: 'not-refundable'; status: string; paymentId: string }
  | { kind: 'currency'; currency: string; paymentId: string }
  | { kind: 'over'; total: number; amount: number; current: number; paymentId: string };

function factFor(ev: PaymentRefundedEvent, refund: ProviderRefund | null, amount: number): RefundFact {
  return {
    providerRefundId: refund?.providerRefundId ?? ev.providerRefundId ?? null,
    amount,
    status: STATUS_IN[refund?.status ?? ev.refundStatus ?? 'succeeded'],
    reason: null,
    initiatedBy: 'PROVIDER',
    providerEventId: ev.providerEventId,
  };
}

async function applyUnderLock(
  tx: Prisma.TransactionClient,
  payment: LockedPayment,
  ev: PaymentRefundedEvent,
  amounts: { single: number | null; listed: ReadonlyArray<{ refund: ProviderRefund; amount: number }> },
  ctx: ApplyContext,
): Promise<RefundOutcome> {
  const before = refundedTotalOf(payment);
  let total = before;
  let written = 0;
  const deliveryIds: string[] = [];
  let state = payment;

  const write = async (fact: RefundFact): Promise<RefundOutcome | null> => {
    const outcome = await writeRefund(tx, state, fact, ctx.log);
    if (outcome.kind === 'over') {
      return { kind: 'over', total: outcome.total, amount: payment.amount, current: outcome.current, paymentId: payment.id };
    }
    if (outcome.kind === 'recorded') written += 1;
    deliveryIds.push(...outcome.deliveryIds);
    total = outcome.total;
    state = {
      ...state,
      refundedAmount: total,
      status: total >= payment.amount ? 'REFUNDED' : total > 0 ? 'PARTIALLY_REFUNDED' : 'SUCCEEDED',
    };
    return null;
  };

  for (const { refund, amount } of amounts.listed) {
    const refused = await write(factFor(ev, refund, amount));
    if (refused !== null) return refused;
  }

  if (ev.refundedTotal !== undefined && amounts.single !== null) {
    // The provider's own running total. Whatever the rows do not yet add up
    // to is one more refund, which the payload did not list.
    const rest = amounts.single - total;
    if (rest > 0) {
      const refused = await write(factFor(ev, null, rest));
      if (refused !== null) return refused;
    }
  } else if (amounts.listed.length === 0 && amounts.single !== null) {
    const named = ev.providerRefundId !== undefined;
    const applied = Array.isArray(payment.metadata.refundEvents) ? (payment.metadata.refundEvents as unknown[]) : [];
    if (!named && applied.includes(ev.providerEventId)) return { kind: 'replay' };
    if (amounts.single > 0) {
      const refused = await write(factFor(ev, null, amounts.single));
      if (refused !== null) return refused;
    }
    if (!named && written > 0) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...payment.metadata,
            refundEvents: [...applied.slice(-(REMEMBERED_REFUND_EVENTS - 1)), ev.providerEventId],
          } as Prisma.InputJsonObject,
        },
      });
    }
  }

  if (written === 0 && total === before) return { kind: 'unchanged' };
  return { kind: 'recorded', total, amount: payment.amount, written, deliveryIds };
}

/**
 * @example
 * await applyPaymentRefunded({ type: 'payment.refunded', providerPaymentId: 'in_1', providerRefundId: 're_1', amount: 500, … }, ctx);
 */
export async function applyPaymentRefunded(ev: PaymentRefundedEvent, ctx: ApplyContext): Promise<void> {
  const gate = (raw: number | null | undefined, field: string): number | null =>
    safeAmount(raw, ctx.log, { providerPaymentId: ev.providerPaymentId, field });

  // What the event reported, for the log entry of a refund that is not recorded.
  const reported = {
    applicationId: ev.applicationId,
    providerEventId: ev.providerEventId,
    providerPaymentId: ev.providerPaymentId,
    kind: 'refund',
    reportedAmount: ev.reportedAmount ?? ev.refundedTotal ?? ev.amount,
    currency: ev.currency,
    ...(ev.providerRefundId !== undefined && { providerRefundId: ev.providerRefundId }),
  } as const;

  const single = gate(ev.refundedTotal ?? ev.amount, ev.refundedTotal !== undefined ? 'refunded_total' : 'refund_amount');
  const listed: Array<{ refund: ProviderRefund; amount: number }> = [];
  for (const refund of ev.refunds ?? []) {
    const amount = gate(refund.amount, 'refund_amount');
    if (amount === null) {
      await logNotRecorded(
        { ...reported, reason: 'amount_not_storable', reportedAmount: refund.amount, providerRefundId: refund.providerRefundId },
        ctx,
      );
      continue;
    }
    if (amount === 0) continue;
    listed.push({ refund, amount });
  }
  if (single === null && listed.length === 0) {
    await logNotRecorded({ ...reported, reason: 'amount_not_storable' }, ctx);
    ctx.note?.(`payment.refunded for "${ev.providerPaymentId}" carried an unusable amount; nothing changed.`);
    return;
  }

  const outcome = await prisma.$transaction(async (tx): Promise<RefundOutcome> => {
    const payment = await lockPaymentForRefund(tx, {
      applicationId: ev.applicationId,
      providerPaymentId: ev.providerPaymentId,
    });
    if (payment === null) return { kind: 'unknown' };
    if (!REFUNDABLE_STATUSES.includes(payment.status)) {
      return { kind: 'not-refundable', status: payment.status, paymentId: payment.id };
    }
    if (ev.currency && ev.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      return { kind: 'currency', currency: payment.currency, paymentId: payment.id };
    }
    const result = await applyUnderLock(tx, payment, ev, { single, listed }, ctx);
    if (result.kind === 'over') {
      // Roll back the refunds this event wrote before the one that went over,
      // so an event is applied whole or not at all.
      throw new RefundOverPayment(result);
    }
    return result;
  }).catch((err: unknown) => {
    if (err instanceof RefundOverPayment) return err.outcome;
    throw err;
  });

  const logContext = { providerPaymentId: ev.providerPaymentId, applicationId: ev.applicationId, outcome };
  switch (outcome.kind) {
    case 'recorded':
      kickDeliveries(outcome.deliveryIds);
      ctx.log.info(logContext, 'payment.refunded: refund recorded; entitlements NOT revoked (see #413)');
      return;
    case 'replay':
    case 'unchanged':
      ctx.log.info(logContext, 'payment.refunded: already recorded');
      return;
    case 'unknown':
      await logNotRecorded({ ...reported, reason: 'payment_unknown' }, ctx);
      ctx.log.warn(logContext, 'payment.refunded: no recorded payment matches');
      ctx.note?.(`payment.refunded: no recorded payment "${ev.providerPaymentId}" in this Application; nothing changed.`);
      return;
    case 'not-refundable':
      await logNotRecorded({ ...reported, reason: 'payment_not_refundable', paymentId: outcome.paymentId }, ctx);
      ctx.log.warn(logContext, 'payment.refunded: payment is not in a refundable status');
      ctx.note?.(`payment.refunded: payment "${ev.providerPaymentId}" is ${outcome.status}, so no refund was recorded.`);
      return;
    case 'currency':
      await logNotRecorded({ ...reported, reason: 'currency_mismatch', paymentId: outcome.paymentId }, ctx);
      ctx.log.error(logContext, 'payment.refunded: currency does not match the payment');
      ctx.note?.(
        `payment.refunded: the refund currency does not match payment "${ev.providerPaymentId}" (${outcome.currency}); nothing changed.`,
      );
      return;
    case 'over':
      await logNotRecorded({ ...reported, reason: 'exceeds_payment', paymentId: outcome.paymentId }, ctx);
      ctx.log.error(logContext, 'payment.refunded: refund exceeds the payment, refused');
      ctx.note?.(
        `BILLING_REFUND_EXCEEDS_PAYMENT: payment "${ev.providerPaymentId}" is ${outcome.amount} and ${outcome.current} ` +
          `is already refunded, so a refunded total of ${outcome.total} was refused; nothing changed.`,
      );
      return;
  }
}

class RefundOverPayment extends Error {
  constructor(readonly outcome: Extract<RefundOutcome, { kind: 'over' }>) {
    super('refund exceeds the payment');
  }
}
