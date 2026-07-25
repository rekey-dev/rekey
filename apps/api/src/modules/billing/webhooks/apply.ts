/**
 * Shared domain appliers for normalized billing events
 * (docs/specs/billing-provider-modules.md, P0).
 *
 * These are the former per-provider handler bodies (stripe.handler.ts)
 * extracted behind the `DomainBillingEvent` shapes so every provider module
 * shares ONE implementation of "money moved / status changed". Provider
 * payload shapes and status maps stay in the modules' `translate`; this
 * file owns the domain writes.
 *
 * The atomicity contract from the July audit is load-bearing and preserved
 * verbatim:
 *   - Payment row + subscription status change commit in ONE $transaction
 *     (+ coupon redemption for successes).
 *   - P2002 on the unique provider_payment_id = webhook replay → the whole
 *     transaction rolls back and the applier skips silently.
 *   - Outbound emission (emitPaymentEvent/emitSubscriptionEvent) and dunning
 *     calls run strictly POST-commit, gated on a NEWLY recorded payment /
 *     an actual status transition — replays announce nothing.
 *   - Entitlements provisioning semantics unchanged (idempotent per period;
 *     first period pinned to the 'initial' anchor).
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import { advanceBillingPeriod } from './period.js';
import { emitPaymentEvent, emitSubscriptionEvent } from './billing-events.js';
import type {
  CheckoutApprovedEvent,
  CheckoutCompletedEvent,
  DomainBillingEvent,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
  SubscriptionPeriodAdvancedEvent,
  SubscriptionStatusEvent,
} from '../providers/module-types.js';
import type { BillingProviderName } from '../credentials.service.js';

export interface ApplyContext {
  log: FastifyBaseLogger;
}

/**
 * Maximum payment amount we'll accept on an inbound webhook, in the
 * smallest currency unit. 100 million USD-equivalent is comfortably
 * above any realistic single-transaction ceiling and well below
 * `Number.MAX_SAFE_INTEGER`. Anything past this is almost certainly a
 * provider-side unit mismatch (dollars vs cents) or a bug, and we'd
 * rather log+ignore than write a poisoned Payment row that downstream
 * dashboards try to sum.
 */
const MAX_PAYMENT_AMOUNT = 10_000_000_000; // 100,000,000.00

function safeAmount(
  raw: number | null | undefined,
  log: FastifyBaseLogger,
  context: { providerPaymentId: string; field: string },
): number | null {
  if (raw == null) return 0;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    log.warn(context, 'webhook amount is non-finite/non-integer/negative — dropping');
    return null;
  }
  if (raw > MAX_PAYMENT_AMOUNT) {
    log.error(
      { ...context, raw, max: MAX_PAYMENT_AMOUNT },
      'webhook amount exceeds MAX_PAYMENT_AMOUNT — refusing to record. Probable unit mismatch.',
    );
    return null;
  }
  return raw;
}

/** Dispatch one normalized event to its applier. Used by the pipeline. */
export async function applyBillingEvent(ev: DomainBillingEvent, ctx: ApplyContext): Promise<void> {
  switch (ev.type) {
    case 'checkout.completed':
      return applyCheckoutCompleted(ev, ctx);
    case 'checkout.approved':
      return applyCheckoutApproved(ev, ctx);
    case 'payment.succeeded':
      return applyPaymentSucceeded(ev, ctx);
    case 'payment.failed':
      return applyPaymentFailed(ev, ctx);
    case 'payment.refunded':
      return applyPaymentRefunded(ev, ctx);
    case 'subscription.activated':
      return applySubscriptionActivated(ev, ctx);
    case 'subscription.canceled':
      return applySubscriptionCanceled(ev, ctx);
    case 'subscription.past_due':
      return applySubscriptionPastDue(ev, ctx);
    case 'subscription.period_advanced':
      return applySubscriptionPeriodAdvanced(ev, ctx);
  }
}

/**
 * Hosted checkout completed: the local PENDING subscription (matched by the
 * checkout-session id stored in its metadata at creation) flips ACTIVE, the
 * provider's subscription id is persisted for future event matching, and
 * the plan's entitlements are provisioned for the FIRST period.
 */
export async function applyCheckoutCompleted(
  ev: CheckoutCompletedEvent,
  ctx: ApplyContext,
): Promise<void> {
  // Pre-transition snapshot so the outbound `subscription.activated` event
  // fires only on a REAL state change — a replayed event whose row is
  // already ACTIVE must not re-announce.
  const before = await prisma.subscription.findFirst({
    where: {
      applicationId: ev.applicationId,
      metadata: { path: ['checkoutSessionId'], equals: ev.checkoutSessionId },
    },
    select: { id: true, status: true },
  });

  const updated = await prisma.subscription.updateMany({
    where: {
      applicationId: ev.applicationId,
      // jsonpath / json filter — Prisma supports `path` here.
      metadata: { path: ['checkoutSessionId'], equals: ev.checkoutSessionId },
    },
    data: {
      status: 'ACTIVE',
      ...(ev.providerSubscriptionId !== null && { providerSubId: ev.providerSubscriptionId }),
      // Activation payloads that carry the period anchor (Razorpay
      // `current_end`) mirror it in the same write; undefined = untouched.
      ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
    },
  });

  // Materialize the plan's entitlements (licenses, credits, …) onto the buyer.
  // Idempotent, and covers both legacy single-kind plans (via synthesizeLegacy)
  // and bundled PlanEntitlement rows.
  if (updated.count > 0) {
    const sub = await prisma.subscription.findFirst({
      where: {
        applicationId: ev.applicationId,
        metadata: { path: ['checkoutSessionId'], equals: ev.checkoutSessionId },
      },
    });
    if (sub) {
      // Checkout provisions the subscription's FIRST period by default —
      // pinned to the 'initial' anchor so the first invoice.paid
      // (subscription_create) collides with it instead of double-granting
      // (see provision()). PayPal's ACTIVATED port sets firstPeriod: false
      // (its bespoke handler never pinned; identical for fresh activations
      // where currentPeriodEnd is null, current-period-anchored on a
      // suspension→reactivation).
      await entitlementsService.provision({
        subscription: sub,
        log: ctx.log,
        firstPeriod: ev.firstPeriod ?? true,
      });
    }
    // Outbound event — only on the PENDING→ACTIVE transition (not on replays
    // that found the row already ACTIVE). Fire-and-forget like the auth emits.
    if (before && before.status !== 'ACTIVE') {
      emitSubscriptionEvent('subscription.activated', before.id);
      // Reactivation of a suspended (PAST_DUE) sub recovers its dunning case
      // (PayPal BILLING.SUBSCRIPTION.ACTIVATED port). No-op when no case is
      // open — a fresh PENDING→ACTIVE checkout (Stripe) has none.
      await dunningService.recoverForSubscription(before.id);
    }
  }

  ctx.log.info(
    { sessionId: ev.checkoutSessionId, applicationId: ev.applicationId, matched: updated.count },
    'checkout completed processed',
  );
}

/**
 * Approved-but-uncaptured one-time order (PayPal Orders v2 —
 * CHECKOUT.ORDER.APPROVED). Port of the bespoke paypal.handler
 * `onOrderApproved`: capture via the provider, then flip the local row
 * ACTIVE and provision. Idempotent — the capture tolerates
 * already-captured, and provision dedupes per period. An incomplete
 * capture leaves the row PENDING (deliberately; the provider retries the
 * webhook).
 */
export async function applyCheckoutApproved(
  ev: CheckoutApprovedEvent,
  ctx: ApplyContext,
): Promise<void> {
  const sub = await prisma.subscription.findFirst({
    where: {
      applicationId: ev.applicationId,
      metadata: { path: ['checkoutSessionId'], equals: ev.checkoutSessionId },
    },
    include: { plan: true },
  });
  if (!sub) {
    ctx.log.warn({ orderId: ev.checkoutSessionId }, 'checkout.approved: no local row matches this order');
    return;
  }

  // Capture the approved order (the provider doesn't auto-capture — that's
  // what routed us to this applier). Dynamic import breaks the
  // apply ↔ providers/index cycle, same as the credentials service does.
  const { getProviderForApplication } = await import('../providers/index.js');
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: ev.applicationId },
  });
  const provider = await getProviderForApplication(application, ev.provider as BillingProviderName);
  if (provider.captureOneTime) {
    const { captured } = await provider.captureOneTime(ev.checkoutSessionId);
    if (!captured) {
      ctx.log.warn({ orderId: ev.checkoutSessionId }, 'checkout.approved: capture did not complete — leaving PENDING');
      return;
    }
  }

  await prisma.subscription.updateMany({
    where: { id: sub.id },
    data: { status: 'ACTIVE', providerSubId: ev.checkoutSessionId },
  });
  await entitlementsService.provision({ subscription: sub, log: ctx.log });
  // `sub` is the pre-update row — emit only on the actual flip to ACTIVE.
  if (sub.status !== 'ACTIVE') {
    emitSubscriptionEvent('subscription.activated', sub.id);
  }
  ctx.log.info(
    { orderId: ev.checkoutSessionId, kind: sub.plan.kind },
    'one-time order captured + fulfilled',
  );
}

/**
 * Successful recurring payment: record the SUCCEEDED Payment row, redeem a
 * pending coupon (same transaction), ensure the subscription is ACTIVE,
 * recover any open dunning case, and (re-)provision entitlements for the
 * paid period.
 */
/**
 * Local-subscription matcher shared by the payment/status appliers.
 * `providerSubId` is the historical (Stripe) key; `checkoutSessionId`, when
 * a module supplies it, ORs in the checkout-time metadata match (Razorpay
 * events can precede the event that persists `providerSubId`). Returns null
 * when the event carries nothing to match on.
 */
function localSubscriptionWhere(
  applicationId: string,
  providerSubscriptionId: string | null,
  checkoutSessionId: string | undefined,
):
  | { applicationId: string; providerSubId: string }
  | { applicationId: string; OR: object[] }
  | null {
  if (providerSubscriptionId && !checkoutSessionId) {
    // Exactly the historical query — no OR clause for Stripe/PayPal.
    return { applicationId, providerSubId: providerSubscriptionId };
  }
  const or: object[] = [];
  if (providerSubscriptionId) or.push({ providerSubId: providerSubscriptionId });
  if (checkoutSessionId) {
    or.push({ metadata: { path: ['checkoutSessionId'], equals: checkoutSessionId } });
  }
  return or.length > 0 ? { applicationId, OR: or } : null;
}

export async function applyPaymentSucceeded(
  ev: PaymentSucceededEvent,
  ctx: ApplyContext,
): Promise<void> {
  const amount = safeAmount(ev.amount, ctx.log, {
    providerPaymentId: ev.providerPaymentId,
    field: 'amount_paid',
  });
  if (amount === null) return; // Refused (see safeAmount).

  // Find local subscription if present so the Payment links to it.
  const where = localSubscriptionWhere(ev.applicationId, ev.providerSubscriptionId, ev.checkoutSessionId);
  const localSub = where ? await prisma.subscription.findFirst({ where }) : null;
  if (!localSub && ev.requireLocalSubscription) {
    // Razorpay posture: an event that matches no local row records nothing
    // (never write an unlinked Payment for a subscription we don't know).
    ctx.log.warn(
      { providerPaymentId: ev.providerPaymentId, providerSubscriptionId: ev.providerSubscriptionId },
      'payment.succeeded: no local subscription matched — skipping',
    );
    return;
  }

  // ----- Coupon redemption: record ONCE here, at payment-success time -----
  // Previously the redemption row was inserted at checkout-session creation,
  // which let abandoned-checkout abuse exhaust per-user / global limits
  // without anyone actually paying. Now we only record when the provider
  // tells us money moved. The redemption is created in the SAME transaction
  // as the Payment row — a redemption failure must not leave a committed
  // payment behind with no redemption to ever record it (the replay path
  // skips the whole block once the payment exists).
  const subMeta = (localSub?.metadata ?? null) as Record<string, unknown> | null;
  const couponId = typeof subMeta?.couponId === 'string' ? subMeta.couponId : null;
  const { couponsService } = couponId
    ? await import('../../coupons/coupons.service.js')
    : { couponsService: null };

  // Idempotent: provider_payment_id is unique; skip on conflict.
  let createdPayment: { id: string } | null = null;
  try {
    createdPayment = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          applicationId: ev.applicationId,
          endUserId: localSub?.endUserId ?? null,
          subscriptionId: localSub?.id ?? null,
          amount,
          currency: (ev.currency ?? 'usd').toUpperCase(),
          status: 'SUCCEEDED',
          providerPaymentId: ev.providerPaymentId,
          description: ev.description ?? null,
          // Test/live isolation: a payment inherits its subscription's mode.
          mode: localSub?.mode ?? ev.mode ?? 'LIVE',
        },
        select: { id: true },
      });
      if (couponsService && couponId && localSub) {
        await couponsService.recordRedemption(
          {
            couponId,
            applicationId: ev.applicationId,
            endUserId: localSub.endUserId,
            subscriptionId: localSub.id,
            paymentId: payment.id,
          },
          tx,
        );
      }
      // Flip the subscription ACTIVE (and mirror a payload-carried period
      // anchor, e.g. Razorpay current_end) in the SAME transaction as the
      // payment — a committed payment must never be left with a stale
      // status or stranded from its period change.
      if (localSub) {
        const subData = {
          ...(localSub.status !== 'ACTIVE' && { status: 'ACTIVE' as const }),
          ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
        };
        if (Object.keys(subData).length > 0) {
          await tx.subscription.update({ where: { id: localSub.id }, data: subData });
        }
      }
      return payment;
    });
  } catch (e) {
    // P2002 = this provider payment id already has a Payment row (webhook
    // replay) — the original transaction committed payment + redemption +
    // status together, so skipping here is safe. Anything else rolls all
    // back and rethrows.
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info(
        { providerPaymentId: ev.providerPaymentId },
        'payment.succeeded: payment already recorded',
      );
    } else {
      throw e;
    }
  }

  // Outbound events — only when a NEW payment row was committed. A replayed
  // payment (P2002 above → createdPayment stays null) emits nothing.
  if (createdPayment) {
    emitPaymentEvent('payment.succeeded', createdPayment.id);
    if (localSub && localSub.status !== 'ACTIVE') {
      // Recovery/activation via payment — a real status transition.
      emitSubscriptionEvent('subscription.activated', localSub.id);
    }
  }

  // Money moved for this subscription — whatever the status-mirror ordering,
  // an OPEN dunning case is now recovered (no-op when none is open).
  if (localSub) {
    await dunningService.recoverForSubscription(localSub.id);
  }

  // Re-provision on every successful payment — this is the recurring-renewal
  // event, so a CREDIT plan refills its per-period credits and a TIMED license
  // extends. `provision()` is idempotent per (subscription, period): its credit
  // anchor is keyed off `currentPeriodEnd`, so a replay within the same period
  // is a no-op while the next billing period (advanced by the status mirror)
  // gets a distinct key and grants fresh credits. Without this, recurring credit
  // packs were granted once at checkout and never refilled. Re-read the row so
  // we provision against the latest currentPeriodEnd.
  if (localSub) {
    const fresh = await prisma.subscription.findUnique({ where: { id: localSub.id } });
    if (fresh) {
      // The FIRST payment provisions the SAME period checkout already did —
      // anchor it 'initial' so the two collide rather than double-grant when
      // the period mirror has already advanced currentPeriodEnd (providers
      // don't order webhooks). Renewals anchor on currentPeriodEnd and refill
      // once each.
      await entitlementsService.provision({
        subscription: fresh,
        log: ctx.log,
        firstPeriod: ev.firstPeriod,
      });
    }
  }
}

/**
 * Failed payment: record the FAILED Payment row and flip the subscription
 * PAST_DUE atomically, then (post-commit, new-payment-gated) emit and open
 * or bump the dunning case.
 */
export async function applyPaymentFailed(ev: PaymentFailedEvent, ctx: ApplyContext): Promise<void> {
  const where = localSubscriptionWhere(ev.applicationId, ev.providerSubscriptionId, ev.checkoutSessionId);
  const localSub = where ? await prisma.subscription.findFirst({ where }) : null;
  if (!localSub && ev.requireLocalSubscription) {
    ctx.log.warn(
      { providerPaymentId: ev.providerPaymentId, providerSubscriptionId: ev.providerSubscriptionId },
      'payment.failed: no local subscription matched — skipping',
    );
    return;
  }

  const failedAmount = safeAmount(ev.amount, ctx.log, {
    providerPaymentId: ev.providerPaymentId,
    field: 'amount_due',
  });
  if (failedAmount === null) return;

  // Record the FAILED payment and flip the subscription to PAST_DUE atomically:
  // a committed payment must never be left behind without its matching status
  // change (or vice versa). Idempotent — provider_payment_id is unique, so a
  // webhook replay hits P2002 and the whole transaction rolls back cleanly.
  let createdPayment: { id: string } | null = null;
  try {
    createdPayment = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          applicationId: ev.applicationId,
          endUserId: localSub?.endUserId ?? null,
          subscriptionId: localSub?.id ?? null,
          amount: failedAmount,
          currency: (ev.currency ?? 'usd').toUpperCase(),
          status: 'FAILED',
          providerPaymentId: ev.providerPaymentId,
          description: ev.description ?? null,
          // Test/live isolation: a payment inherits its subscription's mode.
          mode: localSub?.mode ?? ev.mode ?? 'LIVE',
        },
        select: { id: true },
      });
      if (localSub) {
        await tx.subscription.update({
          where: { id: localSub.id },
          data: { status: 'PAST_DUE' },
        });
      }
      return payment;
    });
  } catch (e) {
    // P2002 = this provider payment id already recorded a FAILED payment
    // (replay) — the original transaction committed payment + status
    // together, so skipping is safe. Anything else rolls both back and
    // rethrows for the provider to retry.
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info({ providerPaymentId: ev.providerPaymentId }, 'payment.failed: already recorded');
    } else {
      throw e;
    }
  }

  // Side effects fire only after the transaction commits, and only when a NEW
  // failed payment was recorded (replays emit nothing / don't re-bump dunning).
  if (createdPayment) {
    emitPaymentEvent('payment.failed', createdPayment.id);
    if (localSub) {
      if (localSub.status !== 'PAST_DUE') {
        emitSubscriptionEvent('subscription.past_due', localSub.id);
      }
      // Open (or bump) the dunning case. The provider keeps retrying the card
      // itself — the case tracks state + notifies; it never re-charges.
      await dunningService.recordPaymentFailure({ subscriptionId: localSub.id, log: ctx.log });
    }
  }
}

/**
 * Refund applier — documented no-op stub. No provider handler records
 * refunds today (the Stripe dispatcher has no `charge.refunded` /
 * `refund.*` coverage), so there is no behavior to extract; the event
 * exists so modules can translate into it once the domain grows a
 * REFUNDED payment status / negative-amount policy. Logged so operators
 * can see refund traffic arriving before it's modeled.
 */
export async function applyPaymentRefunded(
  ev: PaymentRefundedEvent,
  ctx: ApplyContext,
): Promise<void> {
  ctx.log.info(
    { providerPaymentId: ev.providerPaymentId, applicationId: ev.applicationId },
    'payment.refunded received — refunds are not yet modeled; event recorded, no domain change',
  );
}

export async function applySubscriptionActivated(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  return applySubscriptionStatusMirror(ev, ctx);
}

export async function applySubscriptionCanceled(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  return applySubscriptionStatusMirror(ev, ctx);
}

export async function applySubscriptionPastDue(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  return applySubscriptionStatusMirror(ev, ctx);
}

/**
 * Status mirror shared by the three lifecycle appliers — the former
 * onSubscriptionUpdated/onSubscriptionDeleted bodies unified. `ev.status`
 * (the module's mapped local status) drives everything; `ev.type` only
 * routed us here (see SubscriptionStatusEvent docs for why they can
 * diverge for EXPIRED/PENDING).
 *
 * Timestamp fields follow undefined-means-untouched: subscription.updated
 * mirrors all three absolutely (null clears), subscription.deleted sets
 * only canceledAt.
 */
async function applySubscriptionStatusMirror(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  const where =
    localSubscriptionWhere(ev.applicationId, ev.providerSubscriptionId, ev.checkoutSessionId) ??
    { applicationId: ev.applicationId, providerSubId: ev.providerSubscriptionId };
  // Snapshot the pre-state so the outbound lifecycle event fires only when
  // the LOCAL status actually changes (replays / period-only updates emit
  // nothing).
  const existing = await prisma.subscription.findFirst({
    where,
    select: { id: true, status: true },
  });
  await prisma.subscription.updateMany({
    where,
    data: {
      status: ev.status,
      ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
      ...(ev.cancelAt !== undefined && { cancelAt: ev.cancelAt }),
      ...(ev.canceledAt !== undefined && { canceledAt: ev.canceledAt }),
    },
  });
  if (existing && existing.status !== ev.status) {
    if (ev.status === 'ACTIVE') emitSubscriptionEvent('subscription.activated', existing.id);
    else if (ev.status === 'CANCELED') emitSubscriptionEvent('subscription.canceled', existing.id);
    else if (ev.status === 'PAST_DUE') emitSubscriptionEvent('subscription.past_due', existing.id);

    // Dunning case lifecycle mirrors the status transition. A status echo of
    // a failure payment.failed already counted opens no second case
    // (ensureCaseOpen is idempotent per OPEN case) and bumps no counter.
    if (ev.status === 'PAST_DUE') {
      await dunningService.ensureCaseOpen({ subscriptionId: existing.id, log: ctx.log });
    } else if (ev.status === 'ACTIVE') {
      await dunningService.recoverForSubscription(existing.id);
    } else if (ev.status === 'CANCELED' || ev.status === 'EXPIRED') {
      // EXPIRED is terminal too (Razorpay `subscription.completed` — the sub
      // ran its full finite cycle count): close any open case so it doesn't
      // linger. No outbound event for EXPIRED — a natural end, not a
      // cancellation (consumers read the terminal state off the record).
      await dunningService.closeForCanceledSubscription(existing.id);
    }
  }
}

/**
 * Advance the local billing period by one plan interval — the first-class
 * form of the PayPal-only workaround (PayPal never tells us the new period
 * end, so renewals must advance it locally). Calendar-aware via
 * advanceBillingPeriod so the anchor doesn't drift against the provider's
 * anniversary billing.
 *
 * When the event carries `providerPaymentId` (payment-derived rotation:
 * a renewal sale) the applier owns the renewal gate the bespoke PayPal
 * handler had — translate is pure and cannot query, so the gate cannot
 * live there. Without it the applier advances unconditionally for a known
 * subscription (the original P1 contract; no current module uses that
 * spelling).
 */
export async function applySubscriptionPeriodAdvanced(
  ev: SubscriptionPeriodAdvancedEvent,
  ctx: ApplyContext,
): Promise<void> {
  const localSub = await prisma.subscription.findFirst({
    where: { applicationId: ev.applicationId, providerSubId: ev.providerSubscriptionId },
  });
  if (!localSub) {
    ctx.log.warn(
      { providerSubscriptionId: ev.providerSubscriptionId, applicationId: ev.applicationId },
      'subscription.period_advanced for unknown subscription — ignoring',
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
    //     for the period the activation already provisioned — advancing
    //     would double-grant.
    const alreadyRecorded = await prisma.payment.findUnique({
      where: { providerPaymentId: ev.providerPaymentId },
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
