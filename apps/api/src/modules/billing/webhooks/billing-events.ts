/**
 * Outbound billing webhook events — emitted from the Stripe/PayPal/Razorpay
 * inbound handlers via the same dispatch service the auth flows use
 * (`webhookService`, see `modules/webhooks/webhook.service.ts`).
 *
 * Contract:
 *   - **Transactional.** Every helper here takes the Prisma client to write
 *     through, and the callers hand it the `$transaction` client that is
 *     making the state change. The delivery rows therefore commit WITH the
 *     payment / status flip or not at all.
 *
 *     They did not, and the comments elsewhere called it a transactional
 *     outbox anyway. `applyPaymentSucceeded` committed money and then, in a
 *     detached `void (async () => …)()`, re-read the DB to insert the delivery
 *     rows. A pod rotation or a pool timeout in that gap lost
 *     `payment.succeeded` permanently — the delivery poller only re-attempts
 *     rows that already exist, and no row existed. An outbox that starts after
 *     an un-retried async hop is not an outbox.
 *
 *   - **Delivery stays fire-and-forget.** Writing the row is synchronous with
 *     the state change; ATTEMPTING it is not. The caller collects the returned
 *     delivery ids and passes them to `kickDeliveries` after the commit. A
 *     slow or broken consumer endpoint still never delays inbound
 *     provider-webhook processing.
 *
 *   - **Emit only on a real state change.** Callers invoke these only when
 *     they actually transitioned a Subscription's status or created a new
 *     Payment row, so a provider-event replay that changes nothing emits
 *     nothing. (A provider retry after a 5xx on our side may still re-emit —
 *     the delivery payload carries `eventId`, which consumers dedupe on.)
 *
 *   - Payload shape follows the `user.created` convention: a single named
 *     object under `data` with ids + the fields a consumer needs to act
 *     without a follow-up API call (plan slug, amount/currency/status).
 *
 * Every read here goes through the SAME client as the write. Reaching for the
 * global `prisma` from inside a caller's transaction would take a second pool
 * connection while holding the first — the classic way to deadlock a pool
 * under the webhook worker's concurrency — and would read pre-transaction
 * state, so the payload would announce the status the row had BEFORE the
 * change it is announcing.
 */

import { entitlementsService } from '../entitlements.service.js';
import { enqueueEvent, type WebhookDbClient } from '../../webhooks/webhook.service.js';

export type SubscriptionEventType =
  | 'subscription.activated'
  | 'subscription.canceled'
  | 'subscription.past_due'
  // The one member that is not a status transition. `enqueueSubscriptionEvent`
  // needs no branch for it: the payload it builds already carries entitlements
  // resolved through `resolveForSubscription`, which already applies overrides,
  // so this event is the existing shape with different news in it.
  | 'subscription.entitlements_updated';

export type PaymentEventType = 'payment.succeeded' | 'payment.failed';

export type DunningEventType =
  | 'dunning.case_opened'
  | 'dunning.case_recovered'
  | 'dunning.case_exhausted';

/**
 * Enqueue a subscription lifecycle event. Reads the row (joined to its plan)
 * through `client` so the payload reflects the post-transition state.
 *
 * The payload carries `entitlements`: what this subscription actually grants,
 * with its per-subscription overrides applied. The plan slug alone does not
 * answer that — two subscribers on the same plan can hold different quantities
 * via `entitlementOverrides` — so a consumer acting on the grant (provisioning
 * seats, sizing a quota) would otherwise have to follow up with an API call it
 * has no user token for. Shape matches `GET /billing/entitlements`'
 * `entitlements` array so the same parsing works on both.
 *
 * Deliberately no `features` map here. The one on `/billing/entitlements` is a
 * union across every subscription the subject holds (booleans OR-true, numbers
 * max); a per-subscription map of the same name would look like that and mean
 * something narrower, which is the kind of resemblance that gets acted on
 * wrongly. One representation, and it is the unambiguous one.
 *
 * Returns the delivery-row ids to kick after the caller's commit.
 */
export async function enqueueSubscriptionEvent(
  client: WebhookDbClient,
  type: SubscriptionEventType,
  subscriptionId: string,
): Promise<string[]> {
  const sub = await client.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      plan: { select: { slug: true, name: true, amount: true, currency: true, interval: true, kind: true } },
    },
  });
  if (!sub) return []; // Deleted out from under us — nothing to announce.
  // A plan whose entitlements cannot be resolved (deleted out from under us)
  // must not swallow the whole event: the status transition is the news, and
  // an empty list is honest about what we could establish.
  const entitlements = await entitlementsService
    .resolveForSubscription(sub, client)
    .catch(() => []);
  return enqueueEvent(client, {
    applicationId: sub.applicationId,
    type,
    data: {
      subscription: {
        id: sub.id,
        endUserId: sub.endUserId,
        organizationId: sub.beneficiaryOrgId,
        status: sub.status,
        provider: sub.provider,
        planSlug: sub.plan.slug,
        planName: sub.plan.name,
        planKind: sub.plan.kind,
        amount: sub.plan.amount,
        currency: sub.plan.currency,
        interval: sub.plan.interval,
        entitlements,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        canceledAt: sub.canceledAt?.toISOString() ?? null,
        createdAt: sub.createdAt.toISOString(),
      },
    },
  });
}

/**
 * Enqueue a payment event for a just-created Payment row. Looks the row up by
 * id (and its subscription's plan slug, when linked) through `client` — so in
 * the money transaction it reads the payment that has not committed yet, which
 * is the whole point.
 *
 * Returns the delivery-row ids to kick after the caller's commit.
 */
export async function enqueuePaymentEvent(
  client: WebhookDbClient,
  type: PaymentEventType,
  paymentId: string,
): Promise<string[]> {
  const payment = await client.payment.findUnique({
    where: { id: paymentId },
    include: { subscription: { select: { plan: { select: { slug: true } } } } },
  });
  if (!payment) return [];
  return enqueueEvent(client, {
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
        providerPaymentId: payment.providerPaymentId,
        description: payment.description,
        createdAt: payment.createdAt.toISOString(),
      },
    },
  });
}

/**
 * Enqueue a dunning lifecycle event for a DunningCase row. Same contract as
 * the subscription/payment enqueuers — callers invoke this only when a case
 * actually opened or closed, inside the transaction that opened or closed it.
 *
 * Returns the delivery-row ids to kick after the caller's commit.
 */
export async function enqueueDunningEvent(
  client: WebhookDbClient,
  type: DunningEventType,
  dunningCaseId: string,
): Promise<string[]> {
  const dunningCase = await client.dunningCase.findUnique({
    where: { id: dunningCaseId },
    include: {
      subscription: { select: { plan: { select: { slug: true, name: true } } } },
    },
  });
  if (!dunningCase) return [];
  return enqueueEvent(client, {
    applicationId: dunningCase.applicationId,
    type,
    data: {
      dunningCase: {
        id: dunningCase.id,
        subscriptionId: dunningCase.subscriptionId,
        endUserId: dunningCase.endUserId,
        organizationId: dunningCase.organizationId,
        status: dunningCase.status,
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
}
