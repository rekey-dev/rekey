/**
 * The status mirror and the local period advance: what a provider's
 * subscription lifecycle events write.
 */

import { isEntitlingStatus } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { dunningService } from '../dunning.service.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import { advanceBillingPeriod } from './period.js';
import { enqueueSubscriptionEvent } from './billing-events.js';
import { logSubscriptionActivated, logSubscriptionCanceled } from '../money-events.js';
import type { SubscriptionPeriodAdvancedEvent, SubscriptionStatusEvent } from '../providers/module-types.js';
import { localSubscriptionWhere, transitionAllowed, type ApplyContext } from './apply-shared.js';
import { withSenderCancelDateChecked } from './granted-rules.js';

/**
 * Status mirror shared by the three lifecycle appliers, the former
 * onSubscriptionUpdated/onSubscriptionDeleted bodies unified. `ev.status`
 * (the module's mapped local status) drives everything; `ev.type` only
 * routed us here (see SubscriptionStatusEvent docs for why they can
 * diverge for EXPIRED/PENDING).
 *
 * Timestamp fields follow undefined-means-untouched: subscription.updated
 * mirrors all three absolutely (null clears), subscription.deleted sets
 * only canceledAt.
 */
export async function applySubscriptionStatusMirror(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  ev = withSenderCancelDateChecked(ev, new Date(), ctx);
  // No identifier, no write. `localSubscriptionWhere` returns null only when
  // the event carries neither a provider subscription id nor a checkout
  // session id, nothing that names a row.
  //
  // This used to fall back to `{ applicationId, providerSubId: <the id we just
  // established is missing> }`. Prisma drops an `undefined` filter entirely, so
  // that collapsed to `{ applicationId }` and the `updateMany` below mirrored
  // the payload's status onto EVERY subscription in the application; a `null`
  // was worse in a different way, matching every row with no provider, which
  // on a deployment where subscriptions are granted rather than checked out is
  // all of them. One `customer.subscription.deleted` missing its `id` cancels
  // the whole application; one `updated` with `status: active` entitles every
  // abandoned checkout in it. `transitionAllowed` does not save it, because it
  // is evaluated against a single sampled row and then applied to all of them.
  //
  // The type says `providerSubscriptionId: string`, which is why the fallback
  // looked unreachable. Only PayPal's translator actually enforces it; Stripe
  // and Razorpay pass the provider's field through unchecked, so a malformed
  // delivery reaches here with it empty.
  const where = localSubscriptionWhere(
    ev.applicationId,
    ev.providerSubscriptionId,
    ev.checkoutSessionId,
  );
  if (where === null) {
    ctx.log?.warn(
      { applicationId: ev.applicationId, type: ev.type },
      'subscription status event names no subscription, ignored',
    );
    return;
  }
  // Snapshot the pre-state so the outbound lifecycle event fires only when
  // the LOCAL status actually changes (replays / period-only updates emit
  // nothing).
  const existing = await prisma.subscription.findFirst({
    where,
    select: { id: true, status: true, cancelAt: true, provider: true },
  });
  // Same ownership rule as the payment appliers: another provider's row is
  // not this event's to mirror.
  if (existing && ctx.provider && existing.provider !== null && existing.provider !== ctx.provider) {
    ctx.log.warn(
      { subscriptionId: existing.id, rowProvider: existing.provider, eventProvider: ctx.provider, type: ev.type },
      'subscription status event matched a subscription created by another provider, ignored',
    );
    return;
  }
  // A timestamp-only event (no status) describes a live subscription. On a
  // row that has already ended, or never started, the date means nothing
  // and would only read as a scheduled cancellation on a dead row.
  if (existing && ev.status === undefined && !isEntitlingStatus(existing.status)) {
    ctx.log.info(
      { subscriptionId: existing.id, currentStatus: existing.status, providerEventId: ev.providerEventId },
      'timestamp-only status event on a subscription that is not live, ignored',
    );
    return;
  }
  const transitioned = Boolean(existing && ev.status !== undefined && existing.status !== ev.status);
  // A terminal subscription is not reopened by a later-arriving event. This
  // gates the WRITE, not just the announcement: gating only the announcement is
  // how a stale `ACTIVE` re-delivery used to resurrect a CANCELED subscription,
  // entitlements and all, while the outbox stayed silent about it. See
  // transitionAllowed.
  if (existing && ev.status !== undefined && !transitionAllowed(existing.status, ev.status)) {
    ctx.log.warn(
      {
        subscriptionId: existing.id,
        currentStatus: existing.status,
        eventStatus: ev.status,
        providerEventId: ev.providerEventId,
      },
      'billing status event would reopen a terminal subscription, refusing the write',
    );
    return;
  }
  // A cancellation the buyer has already been promised the rest of the period
  // for is NOT shortened by the provider's own cancellation event.
  //
  // This is what makes period-end cancellation possible on a provider that
  // cannot schedule one. PayPal's Subscriptions v1 has a single, immediate
  // cancel (see RealPaypalProvider.cancelSubscription), so asking to cancel at
  // period end terminates the agreement now and PayPal reports it within
  // seconds. Mirroring that report straight onto the local row took the
  // remainder of the period away from the buyer, mid-period, with no refund,
  // moments after the account page had told them "you keep everything you paid
  // for until <date>".
  //
  // The agreement being gone at PayPal is exactly what we wanted: it is what
  // stops the money. What it must not decide is when ENTITLEMENTS end. That
  // date is `cancelAt`, we recorded it ourselves when the cancellation was
  // accepted, and the row is left ACTIVE until `expireIfDue` reaches it.
  //
  // Narrow on purpose:
  //   - only CANCELED. EXPIRED means the subscription ran out its own finite
  //     cycle count, a real ending, not one we scheduled.
  //   - only a `cancelAt` still in the FUTURE, so the provider's event at the
  //     natural end of a scheduled cancellation (Stripe, whose cancellation
  //     really is scheduled, arrives on the day) mirrors normally.
  //   - only from ACTIVE, so it cannot hold a PAST_DUE row open.
  const now = new Date();
  if (
    existing &&
    ev.status === 'CANCELED' &&
    existing.status === 'ACTIVE' &&
    existing.cancelAt !== null &&
    existing.cancelAt > now
  ) {
    ctx.log.info(
      {
        subscriptionId: existing.id,
        cancelAt: existing.cancelAt,
        providerEventId: ev.providerEventId,
      },
      'provider cancelled an agreement we had scheduled, holding the paid period open until cancelAt',
    );
    return;
  }
  // Mirror + outbox row in ONE transaction: the announcement is written with
  // the transition it announces, so a crash between the two cannot leave a
  // CANCELED subscription that nobody was ever told about.
  const deliveryIds = await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: existing ? { id: existing.id } : where,
      data: {
        ...(ev.status !== undefined && { status: ev.status }),
        ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
        ...(ev.trialEndsAt !== undefined && { trialEndsAt: ev.trialEndsAt }),
        ...(ev.cancelAt !== undefined && { cancelAt: ev.cancelAt }),
        ...(ev.canceledAt !== undefined && { canceledAt: ev.canceledAt }),
      },
    });
    // Merged in SQL so a concurrent metadata write on the row is not lost.
    if (existing && ev.canceledAt instanceof Date && ev.canceledAtFromSender === true) {
      await tx.$executeRaw`UPDATE subscriptions
         SET metadata = metadata || jsonb_build_object('senderCanceledAt', ${ev.canceledAt.toISOString()}::text)
       WHERE id = ${existing.id}`;
    }
    if (!transitioned || !existing) return [];
    const provider = ctx.provider ?? existing.provider;
    const origin = {
      actor: { type: 'provider' as const, ...(provider !== null && { id: provider }) },
      provider,
      providerEventId: ev.providerEventId,
      log: ctx.log,
    };
    if (ev.status === 'ACTIVE') await logSubscriptionActivated(tx, existing.id, { via: 'provider', trial: false }, origin);
    if (ev.status === 'TRIALING') await logSubscriptionActivated(tx, existing.id, { via: 'provider', trial: true }, origin);
    if (ev.status === 'CANCELED') await logSubscriptionCanceled(tx, existing.id, { atPeriodEnd: false, cause: 'provider' }, origin);
    // No outbound event for EXPIRED, a natural end, not a cancellation
    // (consumers read the terminal state off the record).
    if (ev.status === 'ACTIVE') return enqueueSubscriptionEvent(tx, 'subscription.activated', existing.id);
    if (ev.status === 'CANCELED') return enqueueSubscriptionEvent(tx, 'subscription.canceled', existing.id);
    if (ev.status === 'PAST_DUE') return enqueueSubscriptionEvent(tx, 'subscription.past_due', existing.id);
    if (ev.status === 'TRIALING') return enqueueSubscriptionEvent(tx, 'subscription.trial_started', existing.id);
    return [];
  });
  kickDeliveries(deliveryIds);
  if (existing && transitioned) {
    // Dunning case lifecycle mirrors the status transition. A status echo of
    // a failure payment.failed already counted opens no second case
    // (ensureCaseOpen is idempotent per OPEN case) and bumps no counter.
    if (ev.status === 'PAST_DUE') {
      await dunningService.ensureCaseOpen({ subscriptionId: existing.id, log: ctx.log });
    } else if (ev.status === 'ACTIVE') {
      await dunningService.recoverForSubscription(existing.id);
    } else if (ev.status === 'CANCELED' || ev.status === 'EXPIRED') {
      // EXPIRED is terminal too (Razorpay `subscription.completed`, the sub
      // ran its full finite cycle count): close any open case so it doesn't
      // linger.
      await dunningService.closeForCanceledSubscription(existing.id);
    }
  }
}

/**
 * Advance the local billing period by one plan interval, the first-class
 * form of the PayPal-only workaround (PayPal never tells us the new period
 * end, so renewals must advance it locally). Calendar-aware via
 * advanceBillingPeriod so the anchor doesn't drift against the provider's
 * anniversary billing.
 *
 * When the event carries `providerPaymentId` (payment-derived rotation:
 * a renewal sale) the applier owns the renewal gate the bespoke PayPal
 * handler had, translate is pure and cannot query, so the gate cannot
 * live there. Without it the applier advances unconditionally for a known
 * subscription (the original P1 contract; no current module uses that
 * spelling).
 */
export async function applySubscriptionPeriodAdvanced(
  ev: SubscriptionPeriodAdvancedEvent,
  ctx: ApplyContext,
): Promise<void> {
  // An empty id here would match an arbitrary row rather than none: Prisma
  // drops an `undefined` filter, and `null` matches every provider-less
  // subscription. Same hazard as the status mirror above; refuse it first.
  if (!ev.providerSubscriptionId) {
    ctx.log.warn(
      { applicationId: ev.applicationId },
      'subscription.period_advanced without a provider subscription id, ignoring',
    );
    return;
  }
  const localSub = await prisma.subscription.findFirst({
    where: { applicationId: ev.applicationId, providerSubId: ev.providerSubscriptionId },
  });
  if (!localSub) {
    ctx.log.warn(
      { providerSubscriptionId: ev.providerSubscriptionId, applicationId: ev.applicationId },
      'subscription.period_advanced for unknown subscription, ignoring',
    );
    return;
  }
  if (ev.providerPaymentId) {
    // Renewal gate, evaluated BEFORE the funding payment is applied (this
    // event precedes payment.succeeded so the renewal re-provision reads
    // the advanced period):
    //   - the funding sale already recorded → a replayed sale must never
    //     advance the period twice;
    //   - no prior SUCCEEDED payment → this is the FIRST sale, which pays
    //     for the period the activation already provisioned, advancing
    //     would double-grant.
    // Scoped by application, see recordCompletionPayment. A global lookup
    // would see ANOTHER tenant's payment for the same charge id and skip the
    // period advance for a renewal this tenant genuinely just had.
    const alreadyRecorded = await prisma.payment.findUnique({
      where: {
        applicationId_providerPaymentId: {
          applicationId: ev.applicationId,
          providerPaymentId: ev.providerPaymentId,
        },
      },
      select: { id: true },
    });
    if (alreadyRecorded) return;
    const priorSucceeded = await prisma.payment.count({
      where: { subscriptionId: localSub.id, status: 'SUCCEEDED' },
    });
    if (priorSucceeded < 1) return;
  }
  const plan = await prisma.plan.findUnique({ where: { id: localSub.planId } });
  // Extend from the current anchor when it's still in the future (normal
  // renewal), from now when it lapsed (recovery after dunning).
  const base =
    localSub.currentPeriodEnd && localSub.currentPeriodEnd > new Date()
      ? localSub.currentPeriodEnd
      : new Date();
  await prisma.subscription.update({
    where: { id: localSub.id },
    data: { currentPeriodEnd: advanceBillingPeriod(base, plan?.interval) },
  });
}
