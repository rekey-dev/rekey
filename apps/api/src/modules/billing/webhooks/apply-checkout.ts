/**
 * The checkout appliers: a provider said a checkout was paid
 * (`checkout.completed`), or that a one-time order was approved and is
 * waiting to be captured (`checkout.approved`).
 *
 * A completion that carries its own charge (a one-time sale) is judged
 * before anything is granted: the charge must be what the checkout was opened
 * at. One that is not is recorded as an UNVERIFIED payment with an unapplied
 * case, and the subscription is left as it was.
 */

import type { Subscription } from '@prisma/client';
import { isEntitlingStatus, ENTITLING_SUBSCRIPTION_STATUSES } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { recordMoneyPathBillingEvent } from '../../billing-log/index.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import { checkoutSessionWhere, providerForSession, recordUnappliedCompletion } from '../checkout-sessions.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import type { BillingProviderName } from '../credentials.service.js';
import { completeCheckoutSession, completionModeAllowed } from '../checkout/sessions.service.js';
import { orderCaptureRefusal } from '../checkout/order-match.js';
import { reportingCurrencyOf } from '../reporting-currency.js';
import { snapshotSubscriptionPrice } from '../subscription-snapshot.js';
import { logNotRecorded } from './not-recorded.js';
import { logPaymentRecorded, logSubscriptionActivated, type Origin } from '../money-events.js';
import type { CheckoutApprovedEvent, CheckoutCompletedEvent } from '../providers/module-types.js';
import { enqueuePaymentEvent, enqueueSubscriptionEvent } from './billing-events.js';
import { judgeCharge, type ChargeVerdict } from './charge-check.js';
import { recordUnappliedCharge, writeSucceededPayment } from './apply-payment.js';
import { clearedOnReactivation, redeemSessionCoupon, safeAmount, transitionAllowed, type ApplyContext } from './apply-shared.js';

function originOf(ev: { providerEventId: string }, ctx: ApplyContext, provider: string | null): Origin {
  const name = ctx.provider ?? provider;
  return { actor: { type: 'provider', ...(name !== null && { id: name }) }, provider: name, providerEventId: ev.providerEventId, log: ctx.log };
}

/**
 * A second checkout completed against a subscription that is already live at
 * another provider subscription id. The row keeps pointing at the
 * relationship that settled first; the other one is live at its processor
 * and not cancellable from here, so it is recorded on the row and in the
 * billing log, never only in a log line.
 */
async function recordOrphanedCompletion(before: Subscription, ev: CheckoutCompletedEvent, ctx: ApplyContext): Promise<void> {
  const provider = providerForSession(before.metadata, ev.checkoutSessionId);
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: before.id },
      data: {
        metadata: recordUnappliedCompletion(before.metadata, {
          checkoutSessionId: ev.checkoutSessionId,
          providerSubId: ev.providerSubscriptionId as string,
          provider,
          at: new Date().toISOString(),
        }) as never,
      },
    });
    await recordMoneyPathBillingEvent(
      tx,
      {
        type: 'payment.not_applied',
        applicationId: ev.applicationId,
        dedupeKey: `payment.not_applied:${ev.providerEventId}:${before.id}`,
        actor: { type: 'provider', ...((ctx.provider ?? provider) != null && { id: (ctx.provider ?? provider) as string }) },
        endUserId: before.endUserId,
        subscriptionId: before.id,
        providerEventId: ev.providerEventId,
        data: { reason: 'duplicate_completion', expected: null, providerPaymentId: ev.payment?.providerPaymentId ?? null },
      },
      ctx.log,
    );
  });
}

type CompletionCharge =
  | { kind: 'none' }
  | { kind: 'refused' }
  | { kind: 'verified'; amount: number; verdict: Extract<ChargeVerdict, { kind: 'apply' }> };

/**
 * Judge the charge a completion carries, before anything is granted for it.
 * `refused` means it was recorded as unverified (or could not be stored at
 * all) and the completion must not be applied.
 */
async function judgeCompletionCharge(ev: CheckoutCompletedEvent, sub: Subscription | null, ctx: ApplyContext): Promise<CompletionCharge> {
  const charge = ev.payment;
  if (!charge) return { kind: 'none' };
  const identity = {
    applicationId: ev.applicationId,
    providerEventId: ev.providerEventId,
    providerPaymentId: charge.providerPaymentId,
    providerSubscriptionId: ev.providerSubscriptionId,
    description: charge.description,
  };
  const amount = safeAmount(charge.amount, ctx.log, { providerPaymentId: charge.providerPaymentId, field: 'amount_total' });
  if (amount === null) {
    await logNotRecorded(
      {
        applicationId: ev.applicationId,
        providerEventId: ev.providerEventId,
        providerPaymentId: charge.providerPaymentId,
        kind: 'charge',
        reason: 'amount_not_storable',
        reportedAmount: charge.amount,
        currency: charge.currency,
      },
      ctx,
    );
    ctx.note?.(
      `checkout.completed: payment "${charge.providerPaymentId}" carried an amount Rekey cannot store, so the checkout ` +
        'was not applied and no payment was recorded. The money is at the provider; reconcile it there.',
    );
    return { kind: 'refused' };
  }
  if (sub === null) {
    const currency = (charge.currency ?? (await reportingCurrencyOf(ev.applicationId))).toUpperCase();
    ctx.note?.(`checkout.completed: payment "${charge.providerPaymentId}" names a checkout Rekey holds no subscription for. It was recorded as unverified.`);
    await recordUnappliedCharge(identity, ctx, { amount, currency }, { reason: 'no_subscription', expected: null, named: null });
    return { kind: 'refused' };
  }
  const verdict = await judgeCharge(
    sub,
    { amount, currency: charge.currency, providerPaymentId: charge.providerPaymentId, providerSessionId: ev.checkoutSessionId },
    ctx,
  );
  if (verdict.kind === 'not_applied') {
    ctx.note?.(`checkout.completed: ${verdict.note}`);
    await recordUnappliedCharge(identity, ctx, { amount, currency: verdict.currency }, { reason: verdict.reason, expected: verdict.expected, named: sub });
    return { kind: 'refused' };
  }
  return { kind: 'verified', amount, verdict };
}

/**
 * Hosted checkout completed: the local PENDING subscription (matched by any
 * checkout-session id the row has issued, see checkout-sessions.ts) becomes
 * ACTIVE or TRIALING, takes the price its session was opened at, and the
 * plan's entitlements are provisioned for the FIRST period. For a one-time
 * purchase this is the only event either Stripe or PayPal produces, so its
 * payment row and coupon redemption land here.
 *
 * @example
 * await applyCheckoutCompleted({ type: 'checkout.completed', checkoutSessionId: 'cs_1', providerSubscriptionId: 'sub_1', … }, ctx);
 */
export async function applyCheckoutCompleted(ev: CheckoutCompletedEvent, ctx: ApplyContext): Promise<void> {
  // An empty identifier does not match nothing, it matches the wrong rows:
  // Prisma strips an `undefined` operator from the JSON path filter below.
  if (!ev.checkoutSessionId) {
    ctx.log.warn({ applicationId: ev.applicationId, type: ev.type }, 'checkout event carries no session id, ignored');
    return;
  }
  if (!(await completionModeAllowed(ev.applicationId, ev.checkoutSessionId, ctx.mode))) {
    ctx.log.error(
      { applicationId: ev.applicationId, sessionId: ev.checkoutSessionId, verifiedMode: ctx.mode, code: 'CHECKOUT_MODE_MISMATCH' },
      'checkout completion verified in a different payment mode than its checkout was started in, not applied',
    );
    ctx.note?.(`CHECKOUT_MODE_MISMATCH: not applied, the checkout for ${ev.checkoutSessionId} was started in the other payment mode`);
    return;
  }
  const where = checkoutSessionWhere(ev.applicationId, ev.checkoutSessionId);
  const before = await prisma.subscription.findFirst({ where });
  // A re-delivered completion for an old session must not resurrect a
  // subscription the buyer cancelled. A genuine re-subscribe walks the row
  // back to PENDING before this event arrives.
  if (before && !transitionAllowed(before.status, 'ACTIVE')) {
    ctx.log.warn(
      { subscriptionId: before.id, currentStatus: before.status, sessionId: ev.checkoutSessionId, providerEventId: ev.providerEventId },
      'checkout completion would reopen a terminal subscription, refusing the write',
    );
    return;
  }

  // The discriminator is the provider subscription id, not the fact of a
  // second event: a re-delivery carries the SAME id and stays idempotent.
  if (
    before &&
    isEntitlingStatus(before.status) &&
    before.providerSubId !== null &&
    ev.providerSubscriptionId !== null &&
    before.providerSubId !== ev.providerSubscriptionId
  ) {
    ctx.log.error(
      {
        subscriptionId: before.id,
        applicationId: ev.applicationId,
        heldProvider: before.provider,
        heldProviderSubId: before.providerSubId,
        orphanedProvider: providerForSession(before.metadata, ev.checkoutSessionId),
        orphanedProviderSubId: ev.providerSubscriptionId,
        sessionId: ev.checkoutSessionId,
        providerEventId: ev.providerEventId,
      },
      'a second checkout completed against an already-live subscription, refusing to overwrite ' +
        'the provider subscription id; the newly completed one is live at its processor and is not cancellable from here',
    );
    await recordOrphanedCompletion(before, ev, ctx);
    return;
  }

  const charge = await judgeCompletionCharge(ev, before, ctx);
  if (charge.kind === 'refused') return;

  // Which processor actually completed, as opposed to which one the most
  // recent checkout was opened at. Null on rows written before
  // `providerBySession` existed, which leaves the column untouched.
  const completingProvider = providerForSession(before?.metadata ?? null, ev.checkoutSessionId);
  const origin = originOf(ev, ctx, completingProvider ?? before?.provider ?? null);

  // Did this checkout mint a free trial at the provider (#478)? The trial
  // ledger knows: the redemption was bound to this session before the
  // provider call returned.
  const trialForSession =
    ev.providerSubscriptionId === null
      ? null
      : await prisma.trialRedemption.findFirst({
          where: { applicationId: ev.applicationId, checkoutSessionId: ev.checkoutSessionId, status: { in: ['RESERVED', 'RELEASED'] } },
          select: { trialDays: true },
        });
  const trialEndsAt =
    trialForSession?.trialDays != null && trialForSession.trialDays > 0
      ? new Date(Date.now() + trialForSession.trialDays * 86_400_000)
      : null;

  const activatedFrom = before && before.status !== 'ACTIVE' ? before : null;
  const { matched, deliveryIds, paymentId } = await prisma.$transaction(async (tx) => {
    const result = await tx.subscription.updateMany({
      where: {
        ...where,
        // The guard above, repeated as a WRITE PREDICATE (#437). Two
        // completions that both read a PENDING row both reach here; stated on
        // the UPDATE, the loser re-evaluates against the winner's committed
        // row and matches nothing instead of overwriting its id.
        ...(ev.providerSubscriptionId !== null && {
          OR: [
            { providerSubId: null },
            { providerSubId: ev.providerSubscriptionId },
            // A PENDING row carrying a stale id is a checkout that never settled.
            { NOT: { status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] } } },
          ],
        }),
      },
      data: {
        // TRIALING while the provider runs a trial clock: both entitle, but
        // unpaid revenue is not reported as MRR.
        status: trialEndsAt !== null ? 'TRIALING' : 'ACTIVE',
        ...(trialEndsAt !== null && { trialEndsAt }),
        ...(ev.providerSubscriptionId !== null && { providerSubId: ev.providerSubscriptionId }),
        ...(completingProvider !== null && { provider: completingProvider }),
        ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
        ...(activatedFrom ? clearedOnReactivation : {}),
      },
    });
    if (result.count === 0 || !before) return { matched: result.count, deliveryIds: [] as string[], paymentId: undefined };

    // The session's price goes onto the subscription before anything reads
    // it: the activation announced below carries what the buyer pays.
    const completed = await completeCheckoutSession(tx, ev.applicationId, ev.checkoutSessionId, origin);
    // A completion Rekey holds no session row for still leaves a paying
    // subscription with a price: the plan's default.
    if (completed === null) {
      await snapshotSubscriptionPrice(tx, {
        subscriptionId: before.id,
        planPriceId: 'default',
        onlyIfUnpriced: true,
        logged: { cause: 'checkout', ...origin },
      });
    }
    const ids: string[] = [];
    let recorded: string | undefined;
    if (charge.kind === 'verified' && ev.payment) {
      const payment = await writeSucceededPayment(
        tx,
        {
          applicationId: ev.applicationId,
          providerEventId: ev.providerEventId,
          providerPaymentId: ev.payment.providerPaymentId,
          providerSubscriptionId: ev.providerSubscriptionId,
          description: ev.payment.description,
        },
        {
          amount: charge.amount,
          currency: charge.verdict.currency,
          verification: 'VERIFIED',
          planPriceId: charge.verdict.price?.planPriceId ?? null,
          unitAmount: charge.verdict.price?.amount ?? null,
          discountAmount: charge.verdict.discountAmount,
          subscriptionId: before.id,
          endUserId: before.endUserId,
        },
        origin.provider ?? null,
      );
      if (payment !== null) {
        await logPaymentRecorded(tx, payment, origin);
        ids.push(...(await enqueuePaymentEvent(tx, 'payment.succeeded', payment.id)));
        recorded = payment.id;
      }
    }
    if (activatedFrom) {
      await logSubscriptionActivated(
        tx,
        activatedFrom.id,
        { via: 'checkout', trial: trialEndsAt !== null, checkoutSessionId: completed?.id },
        origin,
      );
      ids.push(...(await enqueueSubscriptionEvent(tx, 'subscription.activated', activatedFrom.id)));
      // A replay that finds the row already TRIALING started nothing new.
      if (trialEndsAt !== null && activatedFrom.status !== 'TRIALING') {
        ids.push(...(await enqueueSubscriptionEvent(tx, 'subscription.trial_started', activatedFrom.id)));
      }
    }
    return { matched: result.count, deliveryIds: ids, paymentId: recorded };
  });

  // We lost the race: another completion got the row first and this sale is
  // live at its processor with nothing local pointing at it.
  if (matched === 0 && before && ev.providerSubscriptionId !== null) {
    ctx.log.error(
      {
        subscriptionId: before.id,
        applicationId: ev.applicationId,
        heldProviderSubId: before.providerSubId,
        orphanedProviderSubId: ev.providerSubscriptionId,
        sessionId: ev.checkoutSessionId,
        providerEventId: ev.providerEventId,
      },
      'a concurrent checkout completion lost the row, the subscription it created is live at its processor and is not cancellable from here',
    );
    await recordOrphanedCompletion(before, ev, ctx).catch((e: unknown) => {
      ctx.log.error({ err: e, subscriptionId: before.id }, 'could not record the lost completion');
    });
  }

  if (matched > 0) {
    const sub = await prisma.subscription.findFirst({ where });
    if (sub) {
      // The FIRST period, pinned to the 'initial' anchor so the first
      // invoice.paid collides with it instead of double-granting. A one-off
      // plan has no period, so the purchase itself is its identity (#490).
      const paid =
        paymentId ??
        (ev.payment
          ? (
              await prisma.payment.findUnique({
                where: { applicationId_providerPaymentId: { applicationId: ev.applicationId, providerPaymentId: ev.payment.providerPaymentId } },
                select: { id: true },
              })
            )?.id
          : undefined);
      await entitlementsService.provision({
        subscription: sub,
        log: ctx.log,
        firstPeriod: ev.firstPeriod ?? true,
        purchaseRef: ev.checkoutSessionId,
        ...(paid !== undefined && { paymentId: paid }),
      });
      // Post-commit and non-throwing: a redemption or a trial slot must never
      // be able to roll back a payment. Both are idempotent per session.
      await redeemSessionCoupon({ subscription: sub, checkoutSessionId: ev.checkoutSessionId, paymentId: paid }, ctx);
      const { consumeTrial } = await import('../trial-eligibility.service.js');
      await consumeTrial({
        applicationId: sub.applicationId,
        checkoutSessionId: ev.checkoutSessionId,
        subscriptionId: sub.id,
        log: ctx.log,
      });
    }
    // After provisioning, so a consumer sees entitlements before the activation.
    kickDeliveries(deliveryIds);
    if (activatedFrom) await dunningService.recoverForSubscription(activatedFrom.id);
  }

  ctx.log.info({ sessionId: ev.checkoutSessionId, applicationId: ev.applicationId, matched }, 'checkout completed processed');
}

/**
 * Approved-but-uncaptured one-time order (PayPal Orders v2,
 * CHECKOUT.ORDER.APPROVED): read the order back and hold it to what the
 * checkout charged, capture it, then activate and provision. Idempotent: the
 * capture tolerates already-captured, and provisioning dedupes per purchase.
 * An incomplete capture leaves the row PENDING; the money leg
 * (`PAYMENT.CAPTURE.COMPLETED`) activates it when it lands.
 *
 * @example
 * await applyCheckoutApproved({ type: 'checkout.approved', checkoutSessionId: 'ORDER-1', provider: 'paypal', … }, ctx);
 */
export async function applyCheckoutApproved(ev: CheckoutApprovedEvent, ctx: ApplyContext): Promise<void> {
  if (!ev.checkoutSessionId) {
    ctx.log.warn({ applicationId: ev.applicationId, type: ev.type }, 'checkout event carries no session id, ignored');
    return;
  }
  // Before the capture: a sandbox order must not take money for a session the
  // credentials have since moved to live from, or the reverse.
  if (!(await completionModeAllowed(ev.applicationId, ev.checkoutSessionId, ctx.mode))) {
    ctx.log.error(
      { applicationId: ev.applicationId, sessionId: ev.checkoutSessionId, verifiedMode: ctx.mode, code: 'CHECKOUT_MODE_MISMATCH' },
      'order approval verified in a different payment mode than its checkout was started in, not captured',
    );
    ctx.note?.(`CHECKOUT_MODE_MISMATCH: not captured, the checkout for ${ev.checkoutSessionId} was started in the other payment mode`);
    return;
  }
  const sub = await prisma.subscription.findFirst({
    where: checkoutSessionWhere(ev.applicationId, ev.checkoutSessionId),
    include: { plan: true },
  });
  if (!sub) {
    ctx.log.warn({ orderId: ev.checkoutSessionId }, 'checkout.approved: no local row matches this order');
    return;
  }
  // Refused BEFORE the capture: taking the buyer's money for a row that must
  // not be reopened would be worse than the status write.
  if (!transitionAllowed(sub.status, 'ACTIVE')) {
    ctx.log.warn(
      { subscriptionId: sub.id, currentStatus: sub.status, orderId: ev.checkoutSessionId },
      'checkout.approved would reopen a terminal subscription, refusing to capture',
    );
    return;
  }

  // Dynamic import breaks the apply ↔ providers/index cycle.
  const { getProviderForApplication } = await import('../providers/index.js');
  const application = await prisma.application.findUniqueOrThrow({ where: { id: ev.applicationId } });
  const provider = await getProviderForApplication(application, ev.provider as BillingProviderName);
  if (provider.captureOneTime) {
    const refused = await orderCaptureRefusal({ provider, application, subscription: sub, orderId: ev.checkoutSessionId });
    if (refused !== null) {
      ctx.log.error({ orderId: ev.checkoutSessionId, reason: refused }, 'checkout.approved: order does not match its checkout, not captured');
      ctx.note?.(
        `CHECKOUT_CAPTURE_REFUSED: order ${ev.checkoutSessionId} not captured (${refused}); PayPal's record does not match what the checkout charged`,
      );
      return;
    }
    const { captured } = await provider.captureOneTime(ev.checkoutSessionId);
    if (!captured) {
      ctx.log.warn({ orderId: ev.checkoutSessionId }, 'checkout.approved: capture did not complete, leaving PENDING');
      return;
    }
  }

  const origin = originOf(ev, ctx, ev.provider);
  // Conditional on the status read above: concurrent deliveries of one
  // approval all read PENDING, and only the delivery whose write still sees
  // that status announces the activation.
  const deliveryIds = await prisma.$transaction(async (tx) => {
    const flipped = await tx.subscription.updateMany({
      where: { id: sub.id, status: sub.status },
      data: { status: 'ACTIVE', providerSubId: ev.checkoutSessionId },
    });
    const completed = await completeCheckoutSession(tx, ev.applicationId, ev.checkoutSessionId, origin);
    if (completed === null) {
      await snapshotSubscriptionPrice(tx, {
        subscriptionId: sub.id,
        planPriceId: 'default',
        onlyIfUnpriced: true,
        logged: { cause: 'checkout', ...origin },
      });
    }
    if (flipped.count === 0 || sub.status === 'ACTIVE') return [];
    await logSubscriptionActivated(tx, sub.id, { via: 'checkout', trial: false, checkoutSessionId: completed?.id }, origin);
    return enqueueSubscriptionEvent(tx, 'subscription.activated', sub.id);
  });
  // Read again: the completion above gave the row its price.
  const activated = (await prisma.subscription.findUnique({ where: { id: sub.id } })) ?? sub;
  await entitlementsService.provision({ subscription: activated, log: ctx.log, purchaseRef: ev.checkoutSessionId });
  // This applier is the only place that knows a PayPal one-off's coupon was
  // spent: the capture arrives later as its own payment event.
  await redeemSessionCoupon({ subscription: sub, checkoutSessionId: ev.checkoutSessionId }, ctx);
  kickDeliveries(deliveryIds);
  ctx.log.info({ orderId: ev.checkoutSessionId, kind: sub.plan.kind }, 'one-time order captured + fulfilled');
}
