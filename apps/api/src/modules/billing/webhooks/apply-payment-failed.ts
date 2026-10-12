/**
 * The failed-payment applier: record the FAILED payment, move the
 * subscription to PAST_DUE with it, and count the failure on its dunning case.
 */

import type { Subscription } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { dunningService } from '../dunning.service.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import { reportingCurrencyOf } from '../reporting-currency.js';
import { logPaymentFailed } from '../money-events.js';
import type { PaymentFailedEvent } from '../providers/module-types.js';
import { enqueuePaymentEvent, enqueueSubscriptionEvent } from './billing-events.js';
import { LOGGED_PAYMENT, originOf } from './apply-payment.js';
import { logNotRecorded } from './not-recorded.js';
import { findOwnedSubscription, localSubscriptionWhere, safeAmount, transitionAllowed, type ApplyContext } from './apply-shared.js';

/** How many failure event ids a FAILED payment remembers, for replay safety. */
const REMEMBERED_FAILURE_EVENTS = 50;

/** Re-reads before a contended repeat-failure count gives up and asks for a retry. */
const REPEAT_FAILURE_CAS_ATTEMPTS = 5;

/**
 * Note another failed attempt on a payment already recorded FAILED. True only
 * for an event id the row has not seen, so a replay of the same event is not
 * counted twice; false for a replay, or for a payment that has since
 * succeeded (a late failure must not undo the collection). Compare-and-set on
 * `updatedAt`, re-read on contention, so two concurrent deliveries of one
 * event count once and two different failures both count.
 */
async function recordRepeatFailure(ev: PaymentFailedEvent): Promise<boolean> {
  for (let attempt = 0; attempt < REPEAT_FAILURE_CAS_ATTEMPTS; attempt += 1) {
    const row = await prisma.payment.findFirst({
      where: { applicationId: ev.applicationId, providerPaymentId: ev.providerPaymentId },
      select: { id: true, status: true, metadata: true, updatedAt: true },
    });
    if (!row || row.status !== 'FAILED') return false;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const seen = Array.isArray(meta.failureEventIds) ? meta.failureEventIds.filter((x) => typeof x === 'string') : [];
    if (seen.includes(ev.providerEventId)) return false;
    const updated = await prisma.payment.updateMany({
      where: { id: row.id, status: 'FAILED', updatedAt: row.updatedAt },
      data: {
        metadata: { ...meta, failureEventIds: [...seen, ev.providerEventId].slice(-REMEMBERED_FAILURE_EVENTS) },
      },
    });
    if (updated.count === 1) return true;
  }
  throw new Error(`payment ${ev.providerPaymentId}: could not record failure ${ev.providerEventId} under contention; retry.`);
}

/**
 * The currency of a failed charge that names none: the subscription's own,
 * and for a charge that matched nothing the one the Application reports in.
 */
async function failedChargeCurrency(ev: PaymentFailedEvent, sub: Subscription | null): Promise<string> {
  if (ev.currency) return ev.currency.toUpperCase();
  if (sub?.currency) return sub.currency.toUpperCase();
  return (await reportingCurrencyOf(ev.applicationId)).toUpperCase();
}

/**
 * Failed payment: record the FAILED Payment row and flip the subscription
 * PAST_DUE atomically, then (post-commit, new-payment-gated) emit and open
 * or bump the dunning case.
 *
 * @example
 * await applyPaymentFailed({ type: 'payment.failed', providerPaymentId: 'in_2', amount: 1900, currency: 'usd', … }, ctx);
 */
export async function applyPaymentFailed(ev: PaymentFailedEvent, ctx: ApplyContext): Promise<void> {
  const where = localSubscriptionWhere(ev.applicationId, ev.providerSubscriptionId, ev.checkoutSessionId);
  const localSub = where ? await findOwnedSubscription(where, ctx) : null;
  if (!localSub && ev.requireLocalSubscription) {
    ctx.log.warn(
      { providerPaymentId: ev.providerPaymentId, providerSubscriptionId: ev.providerSubscriptionId },
      'payment.failed: no local subscription matched, skipping',
    );
    return;
  }

  const failedAmount = safeAmount(ev.amount, ctx.log, { providerPaymentId: ev.providerPaymentId, field: 'amount_due' });
  if (failedAmount === null) {
    await logNotRecorded(
      {
        applicationId: ev.applicationId,
        providerEventId: ev.providerEventId,
        providerPaymentId: ev.providerPaymentId,
        kind: 'failed_charge',
        reason: 'amount_not_storable',
        reportedAmount: ev.reportedAmount ?? ev.amount,
        currency: ev.currency,
      },
      ctx,
    );
    return;
  }
  const currency = await failedChargeCurrency(ev, localSub);
  // A failure against a CANCELED or EXPIRED row is recorded, but it does not
  // bring the row back into an entitling status or open dunning for it.
  const mayGoPastDue = localSub !== null && transitionAllowed(localSub.status, 'PAST_DUE');
  const origin = originOf(ev, ctx, localSub);

  // The FAILED payment, the PAST_DUE flip, the log and the outbox rows commit
  // together. (application_id, provider_payment_id) is unique, so a replay
  // hits P2002 and the whole transaction rolls back.
  let deliveryIds: string[];
  try {
    deliveryIds = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          applicationId: ev.applicationId,
          endUserId: localSub?.endUserId ?? null,
          subscriptionId: localSub?.id ?? null,
          amount: failedAmount,
          currency,
          status: 'FAILED',
          providerPaymentId: ev.providerPaymentId,
          description: ev.description ?? null,
          metadata: { failureEventIds: [ev.providerEventId] },
          provider: origin.provider ?? null,
          verification: localSub ? 'VERIFIED' : 'UNVERIFIED',
          planPriceId: localSub?.planPriceId ?? null,
          unitAmount: localSub?.unitAmount ?? null,
        },
        select: LOGGED_PAYMENT,
      });
      if (localSub && mayGoPastDue) {
        await tx.subscription.update({ where: { id: localSub.id }, data: { status: 'PAST_DUE' } });
      }
      await logPaymentFailed(tx, payment, origin);
      const ids = await enqueuePaymentEvent(tx, 'payment.failed', payment.id);
      if (localSub && mayGoPastDue && localSub.status !== 'PAST_DUE') {
        ids.push(...(await enqueueSubscriptionEvent(tx, 'subscription.past_due', localSub.id)));
      }
      return ids;
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    if (await recordRepeatFailure(ev)) {
      // Stripe retries the SAME invoice, so a second failed attempt lands
      // here under a new event id. It is a real failure and counts on the
      // open dunning case; nothing new is recorded or announced.
      if (localSub && mayGoPastDue) {
        await dunningService.recordPaymentFailure({ subscriptionId: localSub.id, log: ctx.log });
      }
      ctx.log.info({ providerPaymentId: ev.providerPaymentId }, 'payment.failed: repeat attempt counted');
    } else {
      ctx.log.info({ providerPaymentId: ev.providerPaymentId }, 'payment.failed: already recorded');
    }
    return;
  }

  kickDeliveries(deliveryIds);
  if (localSub && mayGoPastDue) {
    // Open (or bump) the dunning case. The provider keeps retrying the card
    // itself, the case tracks state + notifies; it never re-charges.
    await dunningService.recordPaymentFailure({ subscriptionId: localSub.id, log: ctx.log });
  }
}
