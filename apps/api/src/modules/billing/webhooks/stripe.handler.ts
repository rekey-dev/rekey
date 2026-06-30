/**
 * Stripe webhook event dispatcher.
 *
 * Called by `stripe.routes.ts` after the request signature has been verified
 * and the event row has been inserted into `webhook_events` for durable
 * idempotency. This module's job is to translate Stripe's domain into ours
 * — flipping `Subscription.status`, inserting `Payment` rows, etc.
 *
 * Application identification: every checkout session we create embeds
 * `metadata.applicationId` (set by `RealStripeProvider.createCheckoutSession`,
 * matched by the stub for tests). Subscription objects inherit it. We trust
 * that field here — without it we have no way to scope.
 *
 * Today's coverage:
 *   - checkout.session.completed → Subscription PENDING → ACTIVE
 *   - customer.subscription.updated → status mirror, period end / cancel-at
 *   - customer.subscription.deleted → CANCELED
 *   - invoice.paid → ACTIVE + Payment SUCCEEDED row
 *   - invoice.payment_failed → PAST_DUE + Payment FAILED row
 *
 * Anything else is logged + ignored.
 */

import type Stripe from 'stripe';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import { emitPaymentEvent, emitSubscriptionEvent } from './billing-events.js';

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
  context: { invoiceId: string; field: 'amount_paid' | 'amount_due' },
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

interface DispatchContext {
  log: FastifyBaseLogger;
}

interface ApplicationScopedObject {
  metadata?: { applicationId?: string | null } | null;
}

function extractApplicationId(obj: ApplicationScopedObject | undefined | null): string | null {
  return obj?.metadata?.applicationId ?? null;
}

export async function dispatchStripeEvent(event: Stripe.Event, ctx: DispatchContext): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session, ctx);
    case 'customer.subscription.updated':
      return onSubscriptionUpdated(event.data.object as Stripe.Subscription, ctx);
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event.data.object as Stripe.Subscription, ctx);
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return onInvoicePaid(event.data.object as Stripe.Invoice, ctx);
    case 'invoice.payment_failed':
      return onInvoicePaymentFailed(event.data.object as Stripe.Invoice, ctx);
    default:
      ctx.log.info({ eventType: event.type, eventId: event.id }, 'unhandled stripe event');
  }
}

async function onCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  ctx: DispatchContext,
): Promise<void> {
  const applicationId = extractApplicationId(session);
  if (!applicationId) {
    ctx.log.warn(
      { sessionId: session.id },
      'checkout.session.completed without applicationId metadata — cannot route',
    );
    return;
  }
  // Match on the local PENDING row by checkoutSessionId stored in metadata
  // when we created the session. The provider's subscription id (if present)
  // gets persisted so future events can match by it directly.
  const providerSubId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;

  // Pre-transition snapshot so the outbound `subscription.activated` event
  // fires only on a REAL state change — a replayed event whose row is
  // already ACTIVE must not re-announce.
  const before = await prisma.subscription.findFirst({
    where: {
      applicationId,
      metadata: { path: ['checkoutSessionId'], equals: session.id },
    },
    select: { id: true, status: true },
  });

  const updated = await prisma.subscription.updateMany({
    where: {
      applicationId,
      // jsonpath / json filter — Prisma supports `path` here.
      metadata: { path: ['checkoutSessionId'], equals: session.id },
    },
    data: {
      status: 'ACTIVE',
      ...(providerSubId !== null && { providerSubId }),
    },
  });

  // Materialize the plan's entitlements (licenses, credits, …) onto the buyer.
  // Idempotent, and covers both legacy single-kind plans (via synthesizeLegacy)
  // and bundled PlanEntitlement rows.
  if (updated.count > 0) {
    const sub = await prisma.subscription.findFirst({
      where: {
        applicationId,
        metadata: { path: ['checkoutSessionId'], equals: session.id },
      },
    });
    if (sub) {
      // Checkout always provisions the subscription's FIRST period. Pin it to
      // the 'initial' anchor so the first invoice.paid (subscription_create)
      // collides with it instead of double-granting (see provision()).
      await entitlementsService.provision({ subscription: sub, log: ctx.log, firstPeriod: true });
    }
    // Outbound event — only on the PENDING→ACTIVE transition (not on replays
    // that found the row already ACTIVE). Fire-and-forget like the auth emits.
    if (before && before.status !== 'ACTIVE') {
      emitSubscriptionEvent('subscription.activated', before.id);
    }
  }

  ctx.log.info(
    { sessionId: session.id, applicationId, matched: updated.count },
    'checkout.session.completed processed',
  );
}

async function onSubscriptionUpdated(
  sub: Stripe.Subscription,
  ctx: DispatchContext,
): Promise<void> {
  const applicationId = extractApplicationId(sub);
  if (!applicationId) {
    ctx.log.warn({ subId: sub.id }, 'subscription.updated without applicationId metadata');
    return;
  }
  const newStatus = mapStripeSubStatus(sub.status);
  // Snapshot the pre-state so the outbound lifecycle event fires only when
  // the LOCAL status actually changes (replays / period-only updates emit nothing).
  const existing = await prisma.subscription.findFirst({
    where: { applicationId, providerSubId: sub.id },
    select: { id: true, status: true },
  });
  await prisma.subscription.updateMany({
    where: { applicationId, providerSubId: sub.id },
    data: {
      status: newStatus,
      currentPeriodEnd: sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : null,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    },
  });
  if (existing && existing.status !== newStatus) {
    if (newStatus === 'ACTIVE') emitSubscriptionEvent('subscription.activated', existing.id);
    else if (newStatus === 'CANCELED') emitSubscriptionEvent('subscription.canceled', existing.id);
    else if (newStatus === 'PAST_DUE') emitSubscriptionEvent('subscription.past_due', existing.id);

    // Dunning case lifecycle mirrors the status transition. A status echo of
    // a failure invoice.payment_failed already counted opens no second case
    // (ensureCaseOpen is idempotent per OPEN case) and bumps no counter.
    if (newStatus === 'PAST_DUE') {
      await dunningService.ensureCaseOpen({ subscriptionId: existing.id, log: ctx.log });
    } else if (newStatus === 'ACTIVE') {
      await dunningService.recoverForSubscription(existing.id);
    } else if (newStatus === 'CANCELED') {
      await dunningService.closeForCanceledSubscription(existing.id);
    }
  }
}

async function onSubscriptionDeleted(
  sub: Stripe.Subscription,
  ctx: DispatchContext,
): Promise<void> {
  const applicationId = extractApplicationId(sub);
  if (!applicationId) {
    ctx.log.warn({ subId: sub.id }, 'subscription.deleted without applicationId metadata');
    return;
  }
  const existing = await prisma.subscription.findFirst({
    where: { applicationId, providerSubId: sub.id },
    select: { id: true, status: true },
  });
  await prisma.subscription.updateMany({
    where: { applicationId, providerSubId: sub.id },
    data: {
      status: 'CANCELED',
      canceledAt: new Date(sub.canceled_at ? sub.canceled_at * 1000 : Date.now()),
    },
  });
  // Emit only on the actual transition — a replayed delete on an
  // already-CANCELED row announces nothing.
  if (existing && existing.status !== 'CANCELED') {
    emitSubscriptionEvent('subscription.canceled', existing.id);
    // Subscription died while in dunning → close the case (silently).
    await dunningService.closeForCanceledSubscription(existing.id);
  }
}

async function onInvoicePaid(invoice: Stripe.Invoice, ctx: DispatchContext): Promise<void> {
  const applicationId = extractApplicationId(invoice);
  if (!applicationId) {
    ctx.log.warn({ invoiceId: invoice.id }, 'invoice.paid without applicationId metadata');
    return;
  }
  const amount = safeAmount(invoice.amount_paid, ctx.log, {
    invoiceId: invoice.id,
    field: 'amount_paid',
  });
  if (amount === null) return; // Refused (see safeAmount).

  const subId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
  // Find local subscription if present so the Payment links to it.
  const localSub = subId
    ? await prisma.subscription.findFirst({
        where: { applicationId, providerSubId: subId },
      })
    : null;

  // ----- Coupon redemption: record ONCE here, at payment-success time -----
  // Previously the redemption row was inserted at checkout-session creation,
  // which let abandoned-checkout abuse exhaust per-user / global limits
  // without anyone actually paying. Now we only record when Stripe tells
  // us money moved. The redemption is created in the SAME transaction as
  // the Payment row — a redemption failure must not leave a committed
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
          applicationId,
          endUserId: localSub?.endUserId ?? null,
          subscriptionId: localSub?.id ?? null,
          amount,
          currency: (invoice.currency ?? 'usd').toUpperCase(),
          status: 'SUCCEEDED',
          providerPaymentId: invoice.id,
          description: invoice.description ?? null,
          // Test/live isolation: a payment inherits its subscription's mode.
          mode: localSub?.mode ?? 'LIVE',
        },
        select: { id: true },
      });
      if (couponsService && couponId && localSub) {
        await couponsService.recordRedemption(
          {
            couponId,
            applicationId,
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
    // P2002 = this invoice id already has a Payment row (webhook replay) —
    // the original transaction committed payment + redemption together, so
    // skipping here is safe. Anything else rolls back both rows and rethrows.
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info({ invoiceId: invoice.id }, 'invoice.paid: payment already recorded');
    } else {
      throw e;
    }
  }

  // Outbound event — only when a NEW payment row was committed. A replayed
  // invoice (P2002 above → createdPayment stays null) emits nothing.
  if (createdPayment) {
    emitPaymentEvent('payment.succeeded', createdPayment.id);
  }

  if (localSub && localSub.status !== 'ACTIVE') {
    await prisma.subscription.update({
      where: { id: localSub.id },
      data: { status: 'ACTIVE' },
    });
    // Recovery/activation via payment — a real status transition.
    emitSubscriptionEvent('subscription.activated', localSub.id);
  }

  // Money moved for this subscription — whatever the status-mirror ordering,
  // an OPEN dunning case is now recovered (no-op when none is open).
  if (localSub) {
    await dunningService.recoverForSubscription(localSub.id);
  }

  // Re-provision on every successful invoice — this is the recurring-renewal
  // event, so a CREDIT plan refills its per-period credits and a TIMED license
  // extends. `provision()` is idempotent per (subscription, period): its credit
  // anchor is keyed off `currentPeriodEnd`, so a replay within the same period
  // is a no-op while the next billing period (advanced by subscription.updated)
  // gets a distinct key and grants fresh credits. Without this, recurring credit
  // packs were granted once at checkout and never refilled. Re-read the row so
  // we provision against the latest currentPeriodEnd.
  if (localSub) {
    const fresh = await prisma.subscription.findUnique({ where: { id: localSub.id } });
    if (fresh) {
      // The FIRST invoice (billing_reason: subscription_create) provisions the
      // SAME period checkout already did — anchor it 'initial' so the two
      // collide rather than double-grant when subscription.updated has already
      // advanced currentPeriodEnd (Stripe doesn't order webhooks). Renewals
      // (subscription_cycle) anchor on currentPeriodEnd and refill once each.
      await entitlementsService.provision({
        subscription: fresh,
        log: ctx.log,
        firstPeriod: invoice.billing_reason === 'subscription_create',
      });
    }
  }

}

async function onInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  ctx: DispatchContext,
): Promise<void> {
  const applicationId = extractApplicationId(invoice);
  if (!applicationId) {
    ctx.log.warn({ invoiceId: invoice.id }, 'invoice.payment_failed without applicationId metadata');
    return;
  }
  const subId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
  const localSub = subId
    ? await prisma.subscription.findFirst({
        where: { applicationId, providerSubId: subId },
      })
    : null;

  const failedAmount = safeAmount(invoice.amount_due, ctx.log, {
    invoiceId: invoice.id,
    field: 'amount_due',
  });
  if (failedAmount === null) return;

  const createdPayment = await prisma.payment
    .create({
      data: {
        applicationId,
        endUserId: localSub?.endUserId ?? null,
        subscriptionId: localSub?.id ?? null,
        amount: failedAmount,
        currency: (invoice.currency ?? 'usd').toUpperCase(),
        status: 'FAILED',
        providerPaymentId: invoice.id,
        description: invoice.description ?? null,
        // Test/live isolation: a payment inherits its subscription's mode.
        mode: localSub?.mode ?? 'LIVE',
      },
      select: { id: true },
    })
    .catch((e): null => {
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    });

  // Outbound events — only when a NEW failed payment was recorded / the
  // subscription actually flipped to PAST_DUE (replays emit nothing).
  if (createdPayment) {
    emitPaymentEvent('payment.failed', createdPayment.id);
  }

  if (localSub) {
    await prisma.subscription.update({
      where: { id: localSub.id },
      data: { status: 'PAST_DUE' },
    });
    if (localSub.status !== 'PAST_DUE') {
      emitSubscriptionEvent('subscription.past_due', localSub.id);
    }
    // Open (or bump) the dunning case. Stripe keeps retrying the card itself
    // (Smart Retries) — the case tracks state + notifies; it never re-charges.
    await dunningService.recordPaymentFailure({ subscriptionId: localSub.id, log: ctx.log });
  }
}

/** Map Stripe subscription status strings to our enum values. */
function mapStripeSubStatus(s: Stripe.Subscription.Status): 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED' | 'PENDING' {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    case 'incomplete':
    case 'incomplete_expired':
      return 'EXPIRED';
    case 'paused':
      return 'PENDING';
    default:
      return 'PENDING';
  }
}
