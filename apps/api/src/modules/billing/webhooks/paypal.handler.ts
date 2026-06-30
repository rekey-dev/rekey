/**
 * PayPal webhook event dispatcher.
 *
 * Called by `paypal.routes.ts` after signature verification + durable
 * idempotency insert into `webhook_events`. Translates PayPal's
 * Subscriptions v1 event domain into ReliPay's Subscription / Payment shape.
 *
 * Application scoping: the per-app webhook URL slug identifies the
 * Application (the signature was verified against THAT app's webhook id, so
 * a different PayPal account can't sign for someone else's endpoint). We
 * additionally cross-check `resource.custom_id` (`${appId}:${euId}`, set by
 * RealPaypalProvider.createCheckoutSession) when present.
 *
 * Local subscription matching:
 *   - BILLING.SUBSCRIPTION.* → resource.id is the PayPal subscription id.
 *     The local row was created with metadata.checkoutSessionId == that id;
 *     once we see ACTIVATED we also persist it onto providerSubId.
 *   - PAYMENT.SALE.* → resource.billing_agreement_id is the subscription id.
 *
 * Coverage:
 *   - BILLING.SUBSCRIPTION.ACTIVATED → PENDING → ACTIVE (+ license auto-issue)
 *   - BILLING.SUBSCRIPTION.CANCELLED / EXPIRED → CANCELED
 *   - BILLING.SUBSCRIPTION.SUSPENDED → PAST_DUE (PayPal still retries — not a hard cancel)
 *   - PAYMENT.SALE.COMPLETED → Payment SUCCEEDED + ensure ACTIVE + coupon redemption
 *   - PAYMENT.SALE.DENIED / REVERSED → Payment FAILED + PAST_DUE
 *
 * Anything else logged + ignored.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import { advanceBillingPeriod } from './period.js';
import { emitPaymentEvent, emitSubscriptionEvent } from './billing-events.js';

const MAX_PAYMENT_AMOUNT = 10_000_000_000; // mirror stripe.handler — 100,000,000.00

interface DispatchContext {
  log: FastifyBaseLogger;
  applicationId: string;
}

/** PayPal event envelope (only the fields we read). */
export interface PaypalEvent {
  id: string;
  event_type: string;
  resource?: {
    id?: string;
    custom_id?: string;
    billing_agreement_id?: string;
    status?: string;
    amount?: { total?: string; value?: string; currency_code?: string; currency?: string };
    // PAYMENT.SALE.* uses { amount: { total, currency } }; subscription
    // resources omit amount.
  };
}

/**
 * Parse a PayPal money string ("12.34") in major units into the smallest
 * currency unit (cents). Returns null on anything non-finite / out of range
 * — mirrors stripe.handler's safeAmount posture.
 */
function paypalAmountToMinor(
  value: string | undefined,
  log: FastifyBaseLogger,
  context: Record<string, unknown>,
): number | null {
  if (value == null) return null;
  const major = Number(value);
  if (!Number.isFinite(major) || major < 0) {
    log.warn({ ...context, value }, 'paypal amount non-finite/negative — dropping');
    return null;
  }
  const minor = Math.round(major * 100);
  if (minor > MAX_PAYMENT_AMOUNT) {
    log.error({ ...context, value, max: MAX_PAYMENT_AMOUNT }, 'paypal amount exceeds max — refusing');
    return null;
  }
  return minor;
}

/** Cross-check the `${appId}:${euId}` custom_id when PayPal echoes it. */
function applicationIdMatches(resource: PaypalEvent['resource'], applicationId: string): boolean {
  const custom = resource?.custom_id;
  if (!custom) return true; // PayPal didn't echo it (e.g. PAYMENT.SALE) — trust the URL scope.
  const [appId] = custom.split(':', 1);
  return appId === applicationId;
}

export async function dispatchPaypalEvent(event: PaypalEvent, ctx: DispatchContext): Promise<void> {
  switch (event.event_type) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
      return onSubscriptionActivated(event, ctx);
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
      return onSubscriptionEnded(event, ctx);
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      return onSubscriptionSuspended(event, ctx);
    case 'CHECKOUT.ORDER.APPROVED':
      return onOrderApproved(event, ctx);
    case 'PAYMENT.SALE.COMPLETED':
      return onSaleCompleted(event, ctx);
    case 'PAYMENT.SALE.DENIED':
    case 'PAYMENT.SALE.REVERSED':
      return onSaleFailed(event, ctx);
    default:
      ctx.log.info({ eventType: event.event_type, eventId: event.id }, 'unhandled paypal event');
  }
}

async function onSubscriptionActivated(event: PaypalEvent, ctx: DispatchContext): Promise<void> {
  const subId = event.resource?.id;
  if (!subId || !applicationIdMatches(event.resource, ctx.applicationId)) {
    ctx.log.warn({ eventId: event.id }, 'subscription.activated: missing id or app mismatch');
    return;
  }
  // Pre-transition snapshot — the outbound `subscription.activated` event
  // must only fire when the row actually flips (replays emit nothing).
  const before = await prisma.subscription.findFirst({
    where: {
      applicationId: ctx.applicationId,
      metadata: { path: ['checkoutSessionId'], equals: subId },
    },
    select: { id: true, status: true },
  });

  // Local row created with metadata.checkoutSessionId == PayPal sub id.
  const updated = await prisma.subscription.updateMany({
    where: {
      applicationId: ctx.applicationId,
      metadata: { path: ['checkoutSessionId'], equals: subId },
    },
    data: { status: 'ACTIVE', providerSubId: subId },
  });

  if (updated.count > 0) {
    const sub = await prisma.subscription.findFirst({
      where: { applicationId: ctx.applicationId, providerSubId: subId },
      include: { plan: true },
    });
    if (sub) {
      await entitlementsService.provision({ subscription: sub, log: ctx.log });
    }
    if (before && before.status !== 'ACTIVE') {
      emitSubscriptionEvent('subscription.activated', before.id);
      // Reactivation of a suspended (PAST_DUE) sub recovers its dunning case.
      await dunningService.recoverForSubscription(before.id);
    }
  }
  ctx.log.info({ subId, matched: updated.count }, 'paypal subscription.activated processed');
}

/**
 * One-time purchase (CREDIT pack / perpetual LICENSE) via Orders v2. The buyer
 * approved the order; capture it, then flip the local row ACTIVE and grant /
 * issue. Matched by `metadata.checkoutSessionId == order id`. Idempotent: the
 * capture tolerates already-captured, and the grant/issue helpers dedupe.
 */
async function onOrderApproved(event: PaypalEvent, ctx: DispatchContext): Promise<void> {
  const orderId = event.resource?.id;
  if (!orderId) {
    ctx.log.warn({ eventId: event.id }, 'order.approved: missing order id');
    return;
  }
  const sub = await prisma.subscription.findFirst({
    where: {
      applicationId: ctx.applicationId,
      metadata: { path: ['checkoutSessionId'], equals: orderId },
    },
    include: { plan: true },
  });
  if (!sub) {
    ctx.log.warn({ orderId }, 'order.approved: no local row matches this order');
    return;
  }

  // Capture the approved order (PayPal Orders v2 doesn't auto-capture).
  const { getProviderForApplication } = await import('../providers/index.js');
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: ctx.applicationId },
  });
  const provider = await getProviderForApplication(application, 'paypal');
  if (provider.captureOneTime) {
    const { captured } = await provider.captureOneTime(orderId);
    if (!captured) {
      ctx.log.warn({ orderId }, 'order.approved: capture did not complete — leaving PENDING');
      return;
    }
  }

  await prisma.subscription.updateMany({
    where: { id: sub.id },
    data: { status: 'ACTIVE', providerSubId: orderId },
  });
  await entitlementsService.provision({ subscription: sub, log: ctx.log });
  // `sub` is the pre-update row — emit only on the actual flip to ACTIVE.
  if (sub.status !== 'ACTIVE') {
    emitSubscriptionEvent('subscription.activated', sub.id);
  }
  ctx.log.info({ orderId, kind: sub.plan.kind }, 'paypal one-time order captured + fulfilled');
}

async function onSubscriptionEnded(event: PaypalEvent, ctx: DispatchContext): Promise<void> {
  const subId = event.resource?.id;
  if (!subId) return;
  const existing = await prisma.subscription.findFirst({
    where: { applicationId: ctx.applicationId, providerSubId: subId },
    select: { id: true, status: true },
  });
  await prisma.subscription.updateMany({
    where: { applicationId: ctx.applicationId, providerSubId: subId },
    data: { status: 'CANCELED', canceledAt: new Date() },
  });
  // Emit only on the actual transition (replays on an already-CANCELED row are silent).
  if (existing && existing.status !== 'CANCELED') {
    emitSubscriptionEvent('subscription.canceled', existing.id);
    // Subscription died while in dunning → close the case (silently).
    await dunningService.closeForCanceledSubscription(existing.id);
  }
  ctx.log.info({ subId }, 'paypal subscription ended → CANCELED');
}

async function onSubscriptionSuspended(event: PaypalEvent, ctx: DispatchContext): Promise<void> {
  const subId = event.resource?.id;
  if (!subId) return;
  const existing = await prisma.subscription.findFirst({
    where: { applicationId: ctx.applicationId, providerSubId: subId },
    select: { id: true, status: true },
  });
  // SUSPENDED is PayPal's dunning state, not a hard cancel — mirror Stripe's
  // PAST_DUE so a transient failure doesn't kill the subscription.
  await prisma.subscription.updateMany({
    where: { applicationId: ctx.applicationId, providerSubId: subId },
    data: { status: 'PAST_DUE' },
  });
  if (existing && existing.status !== 'PAST_DUE') {
    emitSubscriptionEvent('subscription.past_due', existing.id);
  }
  if (existing) {
    // PayPal retries the suspended sub itself — our case tracks + notifies.
    // SUSPENDED is a status signal, not a counted payment failure.
    await dunningService.ensureCaseOpen({ subscriptionId: existing.id, log: ctx.log });
  }
  ctx.log.info({ subId }, 'paypal subscription suspended → PAST_DUE');
}

async function onSaleCompleted(event: PaypalEvent, ctx: DispatchContext): Promise<void> {
  const agreementId = event.resource?.billing_agreement_id;
  const localSub = agreementId
    ? await prisma.subscription.findFirst({
        where: { applicationId: ctx.applicationId, providerSubId: agreementId },
      })
    : null;

  const amount = paypalAmountToMinor(
    event.resource?.amount?.total ?? event.resource?.amount?.value,
    ctx.log,
    { eventId: event.id },
  );
  if (amount === null) {
    ctx.log.warn({ eventId: event.id }, 'sale.completed: no usable amount — skipping payment row');
    return;
  }
  const currency = (
    event.resource?.amount?.currency_code ??
    event.resource?.amount?.currency ??
    'USD'
  ).toUpperCase();

  // Coupon redemption is recorded atomically WITH the payment row (one
  // transaction) — a redemption failure must not leave a committed payment
  // behind with no redemption to ever record it (the replay path skips the
  // whole block once the payment exists). Boundary mirrors Stripe: recorded
  // ONCE, at payment-success time.
  const subMeta = (localSub?.metadata ?? null) as Record<string, unknown> | null;
  const couponId = typeof subMeta?.couponId === 'string' ? subMeta.couponId : null;
  const { couponsService } = couponId
    ? await import('../../coupons/coupons.service.js')
    : { couponsService: null };

  let createdPayment: { id: string } | null = null;
  try {
    createdPayment = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          applicationId: ctx.applicationId,
          endUserId: localSub?.endUserId ?? null,
          subscriptionId: localSub?.id ?? null,
          amount,
          currency,
          status: 'SUCCEEDED',
          providerPaymentId: event.resource?.id ?? event.id,
          description: null,
          // Test/live isolation: a payment inherits its subscription's mode.
          mode: localSub?.mode ?? 'LIVE',
        },
        select: { id: true },
      });
      if (couponsService && couponId && localSub) {
        await couponsService.recordRedemption(
          {
            couponId,
            applicationId: ctx.applicationId,
            endUserId: localSub.endUserId,
            subscriptionId: localSub.id,
            paymentId: payment.id,
          },
          tx,
        );
      }
      return payment;
    });
  } catch (e) {
    // P2002 = the payment's providerPaymentId already exists (webhook replay)
    // — the original transaction committed payment + redemption together, so
    // skipping here is safe. Anything else rolls back both rows and rethrows.
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info({ eventId: event.id }, 'sale.completed: payment already recorded (replay)');
    } else {
      throw e;
    }
  }

  // Outbound event — only when a NEW payment row was committed (a replayed
  // sale leaves `createdPayment` null and emits nothing).
  if (createdPayment) {
    emitPaymentEvent('payment.succeeded', createdPayment.id);
  }

  if (localSub && localSub.status !== 'ACTIVE') {
    await prisma.subscription.update({ where: { id: localSub.id }, data: { status: 'ACTIVE' } });
    // Recovery/activation via payment — a real status transition.
    emitSubscriptionEvent('subscription.activated', localSub.id);
  }

  // Money moved for this subscription — an OPEN dunning case is recovered
  // regardless of status-mirror ordering (no-op when none is open).
  if (localSub) {
    await dunningService.recoverForSubscription(localSub.id);
  }

  // Advance the billing period on a genuine RENEWAL sale.
  //
  // `provision()` is idempotent per (subscription, period): its CREDIT/LICENSE
  // anchors are keyed off `currentPeriodEnd`. Stripe rotates that field via
  // `customer.subscription.updated`; PayPal has no equivalent event, so without
  // this the period stayed permanently `null` ("initial") and recurring CREDIT
  // packs were granted once and NEVER refilled (and TIMED licenses never
  // extended) despite the buyer being charged each cycle. See #72 / #73.
  //
  // The FIRST successful sale pays for the same (initial) period the activation
  // already provisioned, so we must NOT advance then (it would double-grant).
  // We advance only once a PRIOR succeeded payment exists for this subscription
  // — i.e. this is the 2nd+ charge = a real renewal. A replayed sale (duplicate
  // providerPaymentId → `createdPayment === null`, or deduped upstream by the
  // webhook-event id) never reaches here with a fresh payment, so it can't
  // advance the period twice.
  if (localSub && createdPayment) {
    const succeededPayments = await prisma.payment.count({
      where: { subscriptionId: localSub.id, status: 'SUCCEEDED' },
    });
    const isRenewal = succeededPayments > 1;
    if (isRenewal) {
      const plan = await prisma.plan.findUnique({ where: { id: localSub.planId } });
      const base =
        localSub.currentPeriodEnd && localSub.currentPeriodEnd > new Date()
          ? localSub.currentPeriodEnd
          : new Date();
      // Calendar-aware: +1 month / +1 year with day-of-month clamping, so the
      // local anchor doesn't drift against PayPal's anniversary billing the
      // way fixed 30/365-day arithmetic did.
      await prisma.subscription.update({
        where: { id: localSub.id },
        data: { currentPeriodEnd: advanceBillingPeriod(base, plan?.interval) },
      });
    }
  }

  // Re-provision on every completed sale — this is the recurring-renewal event,
  // so a CREDIT plan refills its per-period credits and a TIMED license extends.
  // `provision()` is idempotent per (subscription, period), so a replay within a
  // period is a no-op while a new period (advanced above) grants fresh credits.
  // Mirrors the Stripe onInvoicePaid path; without it recurring credit packs
  // never refilled. Re-read so we provision against the advanced period.
  if (localSub) {
    const fresh = await prisma.subscription.findUnique({ where: { id: localSub.id } });
    if (fresh) {
      await entitlementsService.provision({ subscription: fresh, log: ctx.log });
    }
  }

  ctx.log.info({ eventId: event.id, agreementId }, 'paypal sale.completed processed');
}

async function onSaleFailed(event: PaypalEvent, ctx: DispatchContext): Promise<void> {
  const agreementId = event.resource?.billing_agreement_id;
  const localSub = agreementId
    ? await prisma.subscription.findFirst({
        where: { applicationId: ctx.applicationId, providerSubId: agreementId },
      })
    : null;

  const amount =
    paypalAmountToMinor(
      event.resource?.amount?.total ?? event.resource?.amount?.value,
      ctx.log,
      { eventId: event.id },
    ) ?? 0;
  const currency = (
    event.resource?.amount?.currency_code ??
    event.resource?.amount?.currency ??
    'USD'
  ).toUpperCase();

  const createdPayment = await prisma.payment
    .create({
      data: {
        applicationId: ctx.applicationId,
        endUserId: localSub?.endUserId ?? null,
        subscriptionId: localSub?.id ?? null,
        amount,
        currency,
        status: 'FAILED',
        providerPaymentId: event.resource?.id ?? event.id,
        description: null,
        // Test/live isolation: a payment inherits its subscription's mode.
        mode: localSub?.mode ?? 'LIVE',
      },
      select: { id: true },
    })
    .catch((e): null => {
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    });

  // Outbound events — only on a NEW failed-payment row / an actual flip to
  // PAST_DUE; replays emit nothing.
  if (createdPayment) {
    emitPaymentEvent('payment.failed', createdPayment.id);
  }

  if (localSub) {
    await prisma.subscription.update({ where: { id: localSub.id }, data: { status: 'PAST_DUE' } });
    if (localSub.status !== 'PAST_DUE') {
      emitSubscriptionEvent('subscription.past_due', localSub.id);
    }
    // Open (or bump) the dunning case — PayPal keeps retrying on its side;
    // the case tracks state + notifies, it never re-charges.
    await dunningService.recordPaymentFailure({ subscriptionId: localSub.id, log: ctx.log });
  }
  ctx.log.info({ eventId: event.id, agreementId }, 'paypal sale failed → PAST_DUE');
}

