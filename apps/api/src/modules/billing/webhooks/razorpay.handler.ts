/**
 * Razorpay webhook event dispatcher.
 *
 * Called by `razorpay.routes.ts` after the request signature has been verified
 * (offline HMAC-SHA256, mirrors Stripe) and the event row has been inserted
 * into `webhook_events` for durable idempotency. This module translates
 * Razorpay's domain into ours — flipping `Subscription.status`, inserting
 * `Payment` rows, provisioning entitlements.
 *
 * Application scoping: unlike Stripe (which carries `metadata.applicationId`
 * on every object) Razorpay events do NOT echo our app id reliably. The
 * route layer instead resolves the Application from the URL slug and passes
 * `applicationId` down — the signing secret that validated the request is
 * that app's own, so the slug is trustworthy (same trust model as Stripe's
 * per-app endpoint).
 *
 * Local-row matching: at checkout we store the Razorpay object id in
 * `Subscription.metadata.checkoutSessionId` (the subscription id for recurring
 * plans, the payment-link id for one-off purchases — see
 * `RealRazorpayProvider` + `billing.service.createCheckoutSession`). Events
 * match on that, and once matched we persist `providerSubId` so later
 * subscription events can also match by it directly.
 *
 * Today's coverage:
 *   - subscription.activated  → PENDING → ACTIVE, provision first period
 *   - subscription.charged    → ACTIVE + SUCCEEDED Payment, (re)provision
 *   - subscription.cancelled  → CANCELED
 *   - subscription.completed  → EXPIRED (ran its full cycle count)
 *   - subscription.halted     → PAST_DUE + dunning (retries exhausted)
 *   - subscription.pending    → PAST_DUE + dunning (a charge failed, retrying)
 *   - payment_link.paid       → one-off purchase: ACTIVE + SUCCEEDED Payment,
 *                               provision
 *
 * Anything else is logged + ignored.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import { emitPaymentEvent, emitSubscriptionEvent } from './billing-events.js';

/**
 * Maximum payment amount we'll accept on an inbound webhook, in the smallest
 * currency unit. Mirrors the Stripe handler — anything past this is almost
 * certainly a unit mismatch or a bug, and we'd rather log+ignore than write a
 * poisoned Payment row.
 */
const MAX_PAYMENT_AMOUNT = 10_000_000_000; // 100,000,000.00

function safeAmount(
  raw: number | null | undefined,
  log: FastifyBaseLogger,
  context: { paymentId?: string; subscriptionId?: string },
): number | null {
  if (raw == null) return 0;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    log.warn(context, 'razorpay webhook amount is non-finite/non-integer/negative — dropping');
    return null;
  }
  if (raw > MAX_PAYMENT_AMOUNT) {
    log.error(
      { ...context, raw, max: MAX_PAYMENT_AMOUNT },
      'razorpay webhook amount exceeds MAX_PAYMENT_AMOUNT — refusing to record. Probable unit mismatch.',
    );
    return null;
  }
  return raw;
}

// ---------- Razorpay payload shapes (the subset we read) ----------

interface RzpSubscriptionEntity {
  id: string;
  status?: string;
  current_end?: number | null;
  end_at?: number | null;
  paid_count?: number;
  notes?: Record<string, unknown> | null;
}

interface RzpPaymentEntity {
  id: string;
  amount?: number;
  currency?: string;
  description?: string | null;
}

interface RzpPaymentLinkEntity {
  id: string;
  notes?: Record<string, unknown> | null;
}

export interface RazorpayEvent {
  event: string;
  /** Razorpay's per-delivery unique id (from the `x-razorpay-event-id` header). */
  eventId: string;
  created_at?: number;
  payload: {
    subscription?: { entity: RzpSubscriptionEntity };
    payment?: { entity: RzpPaymentEntity };
    payment_link?: { entity: RzpPaymentLinkEntity };
  };
}

interface DispatchContext {
  log: FastifyBaseLogger;
  applicationId: string;
}

export async function dispatchRazorpayEvent(event: RazorpayEvent, ctx: DispatchContext): Promise<void> {
  switch (event.event) {
    case 'subscription.activated':
    case 'subscription.authenticated':
      return onSubscriptionActivated(event, ctx);
    case 'subscription.charged':
      return onSubscriptionCharged(event, ctx);
    case 'subscription.cancelled':
      return onSubscriptionCancelled(event, ctx);
    case 'subscription.completed':
      return onSubscriptionCompleted(event, ctx);
    case 'subscription.halted':
    case 'subscription.pending':
      return onSubscriptionPaymentFailed(event, ctx);
    case 'payment_link.paid':
      return onPaymentLinkPaid(event, ctx);
    default:
      ctx.log.info({ eventType: event.event, eventId: event.eventId }, 'unhandled razorpay event');
  }
}

/**
 * Find the local subscription row this event belongs to. Matches by the
 * Razorpay object id stored at checkout in `metadata.checkoutSessionId`, OR by
 * `providerSubId` once we've persisted it on a prior event. Scoped to the
 * resolved application — no cross-tenant reach.
 */
async function findLocalSubscription(
  applicationId: string,
  rzpObjectId: string,
): Promise<{ id: string; status: string; endUserId: string; mode: string; metadata: unknown } | null> {
  return prisma.subscription.findFirst({
    where: {
      applicationId,
      OR: [
        { metadata: { path: ['checkoutSessionId'], equals: rzpObjectId } },
        { providerSubId: rzpObjectId },
      ],
    },
    select: { id: true, status: true, endUserId: true, mode: true, metadata: true },
  });
}

async function onSubscriptionActivated(event: RazorpayEvent, ctx: DispatchContext): Promise<void> {
  const sub = event.payload.subscription?.entity;
  if (!sub) {
    ctx.log.warn({ eventId: event.eventId }, 'subscription.activated without subscription entity');
    return;
  }
  const local = await findLocalSubscription(ctx.applicationId, sub.id);
  if (!local) {
    ctx.log.warn({ subId: sub.id }, 'razorpay subscription.activated: no local subscription matched');
    return;
  }

  // Persist providerSubId (so later charged/cancelled events match by it) and
  // flip PENDING → ACTIVE. updateMany keeps this idempotent on replays.
  await prisma.subscription.updateMany({
    where: { id: local.id },
    data: {
      status: 'ACTIVE',
      providerSubId: sub.id,
      ...(sub.current_end ? { currentPeriodEnd: new Date(sub.current_end * 1000) } : {}),
    },
  });

  // Provision the FIRST period now. Anchored 'initial' so the first
  // subscription.charged (paid_count === 1) collides with it instead of
  // double-granting.
  const fresh = await prisma.subscription.findUnique({ where: { id: local.id } });
  if (fresh) {
    await entitlementsService.provision({ subscription: fresh, log: ctx.log, firstPeriod: true });
  }

  // Emit only on the real PENDING → ACTIVE transition.
  if (local.status !== 'ACTIVE') {
    emitSubscriptionEvent('subscription.activated', local.id);
  }
  ctx.log.info({ subId: sub.id, applicationId: ctx.applicationId }, 'razorpay subscription.activated processed');
}

async function onSubscriptionCharged(event: RazorpayEvent, ctx: DispatchContext): Promise<void> {
  const sub = event.payload.subscription?.entity;
  const payment = event.payload.payment?.entity;
  if (!sub || !payment) {
    ctx.log.warn({ eventId: event.eventId }, 'subscription.charged missing subscription/payment entity');
    return;
  }
  const local = await findLocalSubscription(ctx.applicationId, sub.id);
  if (!local) {
    ctx.log.warn({ subId: sub.id }, 'razorpay subscription.charged: no local subscription matched');
    return;
  }

  const amount = safeAmount(payment.amount, ctx.log, { paymentId: payment.id, subscriptionId: sub.id });
  if (amount === null) return;

  // ----- Coupon redemption: record ONCE, at payment-success time -----
  // Same posture as the Stripe handler — the coupon id rides on
  // subscription.metadata.couponId and is consumed here so abandoned
  // checkouts can't exhaust redemption limits.
  const subMeta = (local.metadata ?? null) as Record<string, unknown> | null;
  const couponId = typeof subMeta?.couponId === 'string' ? subMeta.couponId : null;
  const { couponsService } = couponId
    ? await import('../../coupons/coupons.service.js')
    : { couponsService: null };

  // Idempotent: providerPaymentId is unique; the payment + redemption commit
  // together so a redemption failure never strands a committed payment.
  let createdPayment: { id: string } | null = null;
  try {
    createdPayment = await prisma.$transaction(async (tx) => {
      const row = await tx.payment.create({
        data: {
          applicationId: ctx.applicationId,
          endUserId: local.endUserId,
          subscriptionId: local.id,
          amount,
          currency: (payment.currency ?? 'INR').toUpperCase(),
          status: 'SUCCEEDED',
          providerPaymentId: payment.id,
          description: payment.description ?? null,
          mode: local.mode as never,
        },
        select: { id: true },
      });
      if (couponsService && couponId) {
        await couponsService.recordRedemption(
          {
            couponId,
            applicationId: ctx.applicationId,
            endUserId: local.endUserId,
            subscriptionId: local.id,
            paymentId: row.id,
          },
          tx,
        );
      }
      return row;
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info({ paymentId: payment.id }, 'razorpay subscription.charged: payment already recorded');
    } else {
      throw e;
    }
  }

  if (createdPayment) {
    emitPaymentEvent('payment.succeeded', createdPayment.id);
  }

  // Advance period end + ensure ACTIVE. Recover any open dunning case.
  await prisma.subscription.updateMany({
    where: { id: local.id },
    data: {
      ...(sub.current_end ? { currentPeriodEnd: new Date(sub.current_end * 1000) } : {}),
      ...(local.status !== 'ACTIVE' ? { status: 'ACTIVE' } : {}),
    },
  });
  if (local.status !== 'ACTIVE') {
    emitSubscriptionEvent('subscription.activated', local.id);
  }
  await dunningService.recoverForSubscription(local.id);

  // Re-provision per charge — refills CREDIT packs, extends TIMED licenses.
  // The FIRST charge (paid_count === 1) pays for the SAME period activation
  // already provisioned, so anchor it 'initial' to collide rather than
  // double-grant. Renewals get a distinct per-period anchor.
  const fresh = await prisma.subscription.findUnique({ where: { id: local.id } });
  if (fresh) {
    await entitlementsService.provision({
      subscription: fresh,
      log: ctx.log,
      firstPeriod: (sub.paid_count ?? 1) <= 1,
    });
  }
  ctx.log.info({ subId: sub.id, paymentId: payment.id }, 'razorpay subscription.charged processed');
}

async function onSubscriptionCancelled(event: RazorpayEvent, ctx: DispatchContext): Promise<void> {
  const sub = event.payload.subscription?.entity;
  if (!sub) return;
  const local = await findLocalSubscription(ctx.applicationId, sub.id);
  if (!local) {
    ctx.log.warn({ subId: sub.id }, 'razorpay subscription.cancelled: no local subscription matched');
    return;
  }
  await prisma.subscription.updateMany({
    where: { id: local.id },
    data: { status: 'CANCELED', canceledAt: new Date((event.created_at ?? Math.floor(Date.now() / 1000)) * 1000) },
  });
  if (local.status !== 'CANCELED') {
    emitSubscriptionEvent('subscription.canceled', local.id);
    await dunningService.closeForCanceledSubscription(local.id);
  }
}

async function onSubscriptionCompleted(event: RazorpayEvent, ctx: DispatchContext): Promise<void> {
  // Razorpay subscriptions run a finite total_count; `completed` fires once
  // all cycles are charged. The plan ran its full course — mark EXPIRED.
  const sub = event.payload.subscription?.entity;
  if (!sub) return;
  const local = await findLocalSubscription(ctx.applicationId, sub.id);
  if (!local) return;
  await prisma.subscription.updateMany({
    where: { id: local.id },
    data: { status: 'EXPIRED' },
  });
  // EXPIRED is a natural end, not a cancellation — no outbound lifecycle event
  // (consumers read the terminal state off the subscription record). Close any
  // open dunning case so it doesn't linger.
  if (local.status !== 'EXPIRED') {
    await dunningService.closeForCanceledSubscription(local.id);
  }
}

async function onSubscriptionPaymentFailed(event: RazorpayEvent, ctx: DispatchContext): Promise<void> {
  // halted = retries exhausted; pending = a charge failed, Razorpay retrying.
  // Both mean the subscription is not currently paid → PAST_DUE + dunning.
  const sub = event.payload.subscription?.entity;
  if (!sub) return;
  const local = await findLocalSubscription(ctx.applicationId, sub.id);
  if (!local) {
    ctx.log.warn({ subId: sub.id }, 'razorpay subscription failure: no local subscription matched');
    return;
  }

  // Record a FAILED Payment row only when the event carries the failed charge.
  const payment = event.payload.payment?.entity;
  if (payment) {
    const amount = safeAmount(payment.amount, ctx.log, { paymentId: payment.id, subscriptionId: sub.id });
    if (amount !== null) {
      const created = await prisma.payment
        .create({
          data: {
            applicationId: ctx.applicationId,
            endUserId: local.endUserId,
            subscriptionId: local.id,
            amount,
            currency: (payment.currency ?? 'INR').toUpperCase(),
            status: 'FAILED',
            providerPaymentId: payment.id,
            description: payment.description ?? null,
            mode: local.mode as never,
          },
          select: { id: true },
        })
        .catch((e): null => {
          if ((e as { code?: string }).code === 'P2002') return null;
          throw e;
        });
      if (created) emitPaymentEvent('payment.failed', created.id);
    }
  }

  await prisma.subscription.updateMany({
    where: { id: local.id },
    data: { status: 'PAST_DUE' },
  });
  if (local.status !== 'PAST_DUE') {
    emitSubscriptionEvent('subscription.past_due', local.id);
  }
  // Razorpay handles the card retries itself — the case only tracks state +
  // notifies, it never re-charges.
  await dunningService.recordPaymentFailure({ subscriptionId: local.id, log: ctx.log });
}

async function onPaymentLinkPaid(event: RazorpayEvent, ctx: DispatchContext): Promise<void> {
  // One-off purchase (CREDIT pack / perpetual license). The local row was
  // created at checkout with metadata.checkoutSessionId = payment-link id.
  const link = event.payload.payment_link?.entity;
  const payment = event.payload.payment?.entity;
  if (!link || !payment) {
    ctx.log.warn({ eventId: event.eventId }, 'payment_link.paid missing payment_link/payment entity');
    return;
  }
  const local = await findLocalSubscription(ctx.applicationId, link.id);
  if (!local) {
    ctx.log.warn({ linkId: link.id }, 'razorpay payment_link.paid: no local subscription matched');
    return;
  }

  const amount = safeAmount(payment.amount, ctx.log, { paymentId: payment.id });
  if (amount === null) return;

  const subMeta = (local.metadata ?? null) as Record<string, unknown> | null;
  const couponId = typeof subMeta?.couponId === 'string' ? subMeta.couponId : null;
  const { couponsService } = couponId
    ? await import('../../coupons/coupons.service.js')
    : { couponsService: null };

  let createdPayment: { id: string } | null = null;
  try {
    createdPayment = await prisma.$transaction(async (tx) => {
      const row = await tx.payment.create({
        data: {
          applicationId: ctx.applicationId,
          endUserId: local.endUserId,
          subscriptionId: local.id,
          amount,
          currency: (payment.currency ?? 'INR').toUpperCase(),
          status: 'SUCCEEDED',
          providerPaymentId: payment.id,
          description: payment.description ?? null,
          mode: local.mode as never,
        },
        select: { id: true },
      });
      if (couponsService && couponId) {
        await couponsService.recordRedemption(
          {
            couponId,
            applicationId: ctx.applicationId,
            endUserId: local.endUserId,
            subscriptionId: local.id,
            paymentId: row.id,
          },
          tx,
        );
      }
      return row;
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info({ paymentId: payment.id }, 'razorpay payment_link.paid: payment already recorded');
    } else {
      throw e;
    }
  }

  if (createdPayment) {
    emitPaymentEvent('payment.succeeded', createdPayment.id);
  }

  // Mark ACTIVE + provision the (single) period. Idempotent provision anchors
  // on 'initial' so a replayed payment_link.paid grants nothing twice.
  await prisma.subscription.updateMany({
    where: { id: local.id },
    data: { ...(local.status !== 'ACTIVE' ? { status: 'ACTIVE' } : {}) },
  });
  const fresh = await prisma.subscription.findUnique({ where: { id: local.id } });
  if (fresh) {
    await entitlementsService.provision({ subscription: fresh, log: ctx.log, firstPeriod: true });
  }
  if (local.status !== 'ACTIVE') {
    emitSubscriptionEvent('subscription.activated', local.id);
  }
  ctx.log.info({ linkId: link.id, paymentId: payment.id }, 'razorpay payment_link.paid processed');
}
