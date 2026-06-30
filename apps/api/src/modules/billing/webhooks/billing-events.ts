/**
 * Outbound billing webhook events — emitted from the Stripe/PayPal inbound
 * handlers via the same dispatch service the auth flows use
 * (`webhookService.emit`, see `modules/webhooks/webhook.service.ts`).
 *
 * Contract (mirrors the auth emit-sites):
 *   - **Fire-and-forget.** Both helpers return void and swallow their own
 *     errors — a slow/broken consumer endpoint must never fail or delay
 *     inbound provider-webhook processing.
 *   - **Emit only on a real state change.** Callers invoke these only when
 *     they actually transitioned a Subscription's status or created a new
 *     Payment row, so a provider-event replay that changes nothing emits
 *     nothing. (A provider retry after a 5xx on our side may still re-emit —
 *     the delivery payload carries `eventId`, which consumers dedupe on.)
 *   - Payload shape follows the `user.created` convention: a single named
 *     object under `data` with ids + the fields a consumer needs to act
 *     without a follow-up API call (plan slug, amount/currency/status).
 */

import { prisma } from '../../../lib/prisma.js';
import { webhookService } from '../../webhooks/webhook.service.js';

export type SubscriptionEventType =
  | 'subscription.activated'
  | 'subscription.canceled'
  | 'subscription.past_due';

export type PaymentEventType = 'payment.succeeded' | 'payment.failed';

export type DunningEventType =
  | 'dunning.case_opened'
  | 'dunning.case_recovered'
  | 'dunning.case_exhausted';

/**
 * Emit a subscription lifecycle event. Re-reads the row (joined to its plan)
 * so the payload reflects the post-transition state — the read happens in the
 * background, off the inbound handler's critical path.
 */
export function emitSubscriptionEvent(type: SubscriptionEventType, subscriptionId: string): void {
  void (async () => {
    const sub = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        plan: { select: { slug: true, name: true, amount: true, currency: true, interval: true, kind: true } },
      },
    });
    if (!sub) return; // Deleted out from under us — nothing to announce.
    await webhookService.emit({
      applicationId: sub.applicationId,
      type,
      data: {
        subscription: {
          id: sub.id,
          endUserId: sub.endUserId,
          organizationId: sub.beneficiaryOrgId,
          status: sub.status,
          // Test/live isolation: 'TEST' for sandbox checkouts (rp_test_* key).
          mode: sub.mode,
          provider: sub.provider,
          planSlug: sub.plan.slug,
          planName: sub.plan.name,
          planKind: sub.plan.kind,
          amount: sub.plan.amount,
          currency: sub.plan.currency,
          interval: sub.plan.interval,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          canceledAt: sub.canceledAt?.toISOString() ?? null,
          createdAt: sub.createdAt.toISOString(),
        },
      },
    });
  })().catch(() => undefined);
}

/**
 * Emit a payment event for a just-created Payment row. Looks the row up by id
 * (and its subscription's plan slug, when linked) in the background.
 */
export function emitPaymentEvent(type: PaymentEventType, paymentId: string): void {
  void (async () => {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { subscription: { select: { plan: { select: { slug: true } } } } },
    });
    if (!payment) return;
    await webhookService.emit({
      applicationId: payment.applicationId,
      type,
      data: {
        payment: {
          id: payment.id,
          endUserId: payment.endUserId,
          subscriptionId: payment.subscriptionId,
          planSlug: payment.subscription?.plan.slug ?? null,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          // Test/live isolation: inherited from the subscription at creation.
          mode: payment.mode,
          providerPaymentId: payment.providerPaymentId,
          description: payment.description,
          createdAt: payment.createdAt.toISOString(),
        },
      },
    });
  })().catch(() => undefined);
}

/**
 * Emit a dunning lifecycle event for a DunningCase row. Same fire-and-forget /
 * transition-only contract as the subscription/payment emitters — callers
 * invoke this only when a case actually opened or closed.
 */
export function emitDunningEvent(type: DunningEventType, dunningCaseId: string): void {
  void (async () => {
    const dunningCase = await prisma.dunningCase.findUnique({
      where: { id: dunningCaseId },
      include: {
        subscription: { select: { mode: true, plan: { select: { slug: true, name: true } } } },
      },
    });
    if (!dunningCase) return;
    await webhookService.emit({
      applicationId: dunningCase.applicationId,
      type,
      data: {
        dunningCase: {
          id: dunningCase.id,
          subscriptionId: dunningCase.subscriptionId,
          endUserId: dunningCase.endUserId,
          organizationId: dunningCase.organizationId,
          status: dunningCase.status,
          // Test/live isolation: a case inherits its subscription's mode.
          mode: dunningCase.subscription.mode,
          planSlug: dunningCase.subscription.plan.slug,
          planName: dunningCase.subscription.plan.name,
          failedAttempts: dunningCase.failedAttempts,
          remindersSent: dunningCase.remindersSent,
          lastFailureAt: dunningCase.lastFailureAt?.toISOString() ?? null,
          nextActionAt: dunningCase.nextActionAt?.toISOString() ?? null,
          openedAt: dunningCase.openedAt.toISOString(),
          closedAt: dunningCase.closedAt?.toISOString() ?? null,
        },
      },
    });
  })().catch(() => undefined);
}
