/**
 * Cancelling a subscription: the end user's own, one named by id, and every
 * provider-side subscription of an end user who is being deleted.
 */

import type { Application, EndUser, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { withProviderErrors } from '../../lib/provider-errors.js';

import { getProviderForApplication } from './providers/index.js';
import { getModule } from './providers/registry.js';
import { type BillingProviderName } from './credentials.service.js';
import { cancelEffect, type CancelReason } from '@rekey.dev/shared-types';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { billingService } from './billing.service.js';
import { logSubscriptionCanceled } from './money-events.js';
import { isOneTimePlan } from './plan-kind.js';

/** A provider that only receives events and can be asked for nothing. */
function isInboundOnlyProvider(provider: string | null): boolean {
  return provider !== null && getModule(provider)?.capabilities.checkout === false;
}

/**
 * Cancel the calling end-user's current subscription (self-service portal
 * surface). Semantics:
 *
 *   - No ACTIVE/PAST_DUE/PENDING subscription → 404 SUBSCRIPTION_NOT_FOUND.
 *   - A one-time plan (credit pack, perpetual licence) → 409
 *     SUBSCRIPTION_NOT_CANCELABLE: it bills once and has nothing to stop.
 *   - Default (`atPeriodEnd !== false`) on an ACTIVE sub with a known period
 *     end → the local row records `cancelAt = currentPeriodEnd` while staying
 *     ACTIVE, and any provider is told to stop at period end. The status
 *     flips to CANCELED when the provider's webhook announces the actual
 *     termination (subscription.deleted / .updated), or, for a row with no
 *     provider, when `expireIfDue` reads it after the date has passed.
 *   - Everything else (PENDING checkout that never activated, PAST_DUE, an
 *     explicit `atPeriodEnd: false`, or an ACTIVE sub with no known period
 *     end) → local status update to CANCELED now; the provider is still told
 *     to cancel when a provider-side subscription exists. Emits
 *     `subscription.canceled`.
 *
 * Which of the two a given subscription gets is `cancelEffect` in
 * `@rekey.dev/shared-types`, exported so a confirmation dialog can say it
 * before the call rather than guessing.
 *
 * Idempotent: cancelling an already-pending-cancel sub returns it unchanged.
 */
export async function cancelCurrentSubscription(
  application: Application,
  endUser: EndUser,
  opts?: {
    atPeriodEnd?: boolean;
    organizationId?: string;
    subscriptionId?: string;
    reason?: CancelReason;
    feedback?: string;
  },
): Promise<Subscription> {
  const said = {
    ...(opts?.reason !== undefined && { cancelReason: opts.reason }),
    ...(opts?.feedback !== undefined && { cancelFeedback: opts.feedback }),
  };
  const sub = opts?.subscriptionId
    ? await billingService.findOwnSubscription(application, endUser, opts.subscriptionId, opts.organizationId)
    : await billingService.getCurrentSubscription(
        application,
        endUser,
        opts?.organizationId ? { organizationId: opts.organizationId } : undefined,
      );
  // A checkout nobody finished is not a subscription: nothing was paid for
  // it and nothing entitles through it. Cancelling one by id would announce
  // a cancellation of something that never started. A PENDING row that
  // carries a provider id (Stripe's `paused`) was paid and stays cancellable.
  if (opts?.subscriptionId && sub?.status === 'PENDING' && sub.providerSubId === null) {
    throw new RekeyError({
      statusCode: 409,
      code: 'SUBSCRIPTION_CHECKOUT_UNFINISHED',
      message: `Subscription "${sub.id}" is a checkout that was never completed, so there is nothing to cancel.`,
      fix: 'Leave it: it bills nothing and grants nothing, and a new checkout for the same plan reuses it. GET /api/v1/billing/subscriptions lists the live subscriptions that can be cancelled.',
    });
  }
  if (!sub) {
    throw new RekeyError({
      statusCode: 404,
      code: 'SUBSCRIPTION_NOT_FOUND',
      message: opts?.subscriptionId
        ? `No subscription "${opts.subscriptionId}" belongs to this billing subject.`
        : 'You have no active subscription to cancel.',
      fix: opts?.subscriptionId
        ? 'List the caller\'s live subscriptions with GET /api/v1/billing/subscriptions (pass the same `organizationId`) and send one of their ids.'
        : 'Nothing to do, the user is not subscribed (or the subscription is already canceled).',
    });
  }

  // Terminal already. `getCurrentSubscription` can hand this a row that
  // `expireIfDue` just wrote EXPIRED, and `cancelEffect('EXPIRED')` is
  // 'immediate', so without this the unconditional update rewrote a
  // terminal row to CANCELED and announced a cancellation that did not
  // happen. `cancelSubscriptionById` has always had this guard.
  if (sub.status === 'CANCELED' || sub.status === 'EXPIRED') return sub;

  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: sub.planId } });
  // A PENDING one is an unpaid checkout, which the buyer may still abandon.
  if (isOneTimePlan(plan) && sub.status !== 'PENDING') {
    throw new RekeyError({
      statusCode: 409,
      code: 'SUBSCRIPTION_NOT_CANCELABLE',
      message: `Subscription "${sub.id}" is a one-time purchase of plan "${plan.slug}", so it has no renewal to cancel.`,
      fix: 'Nothing renews or bills again, so leave it. To end a recurring plan, pass its `subscriptionId` from GET /api/v1/billing/subscriptions.',
    });
  }

  const providerBacked = Boolean(sub.provider && sub.providerSubId);
  // Scheduling a cancellation for the end of the period does NOT require a
  // payment provider. It used to: `providerBacked` was part of this
  // predicate, so a subscription with no provider-side id fell through to
  // the immediate branch below and was CANCELED on the spot, with the free
  // ceiling written the same moment, no refund, mid-period, while the
  // caller had explicitly asked for period-end.
  //
  // That is not an edge case here. Rekey Cloud sells with
  // `COMMERCE_CHECKOUT_ENABLED` off, so every subscription it has today is
  // provisioned by hand and carries no provider record. For those buyers
  // "cancel at the end of the period" meant "cancel now, keep the money".
  //
  // What a provider genuinely changes is who *terminates* the subscription
  // when the date arrives: provider-backed rows wait for the provider's
  // webhook, and rows without one are expired locally by `expireIfDue`
  // below. Both end up CANCELED at `currentPeriodEnd`; only the mechanism
  // differs.
  //
  // The predicate itself is `cancelEffect` in `@rekey.dev/shared-types`
  // rather than three lines here, because a UI has to describe this outcome
  // BEFORE the call and therefore cannot read it off the response. Written
  // out twice it drifted within a day (see that function's docblock). This
  // is the only site that decides it; everyone else asks.
  const atPeriodEnd = opts?.atPeriodEnd !== false && cancelEffect(sub) === 'period-end';

  // Already scheduled to cancel at period end → idempotent no-op.
  if (atPeriodEnd && sub.cancelAt !== null) return sub;

  if (providerBacked) {
    const provider = await getProviderForApplication(
      application,
      sub.provider as BillingProviderName,
    );
    // End-user-facing cancel, same audience rule as checkout above.
    await withProviderErrors(
      {
        provider: sub.provider as string,
        operation: 'subscription cancellation',
        audience: 'end-user',
      },
      () => provider.cancelSubscription({ subscription: sub, atPeriodEnd }),
    );
  }

  if (atPeriodEnd) {
    // Stays ACTIVE until the provider terminates it; record the scheduled
    // end so portals can render "cancels on <date>".
    return prisma.$transaction(async (tx) => {
      const scheduled = await tx.subscription.update({
        where: { id: sub.id },
        data: { cancelAt: sub.currentPeriodEnd, ...said },
      });
      await logSubscriptionCanceled(tx, sub.id, { atPeriodEnd: true, cause: 'end_user' }, { actor: { type: 'end_user', id: endUser.id } });
      return scheduled;
    });
  }

  // Cancel + its outbox row in one transaction: the customer's own cancel is
  // a state change a consumer has to hear about, so it must not be able to
  // commit without the announcement (see webhooks/apply.ts).
  const now = new Date();
  const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
    const row = await tx.subscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELED', canceledAt: now, cancelAt: now, ...said },
    });
    await logSubscriptionCanceled(tx, row.id, { atPeriodEnd: false, cause: 'end_user' }, { actor: { type: 'end_user', id: endUser.id } });
    return {
      updated: row,
      deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.canceled', row.id),
    };
  });
  kickDeliveries(deliveryIds);
  // Self-service cancel while PAST_DUE, close the dunning case (silently).
  const { dunningService } = await import('./dunning.service.js');
  await dunningService.closeForCanceledSubscription(updated.id);
  return updated;
}

/**
 * Operator-facing cancel of a SPECIFIC subscription by id (e.g. via the
 * operator MCP `cancel_subscription` tool). Mirrors `cancelCurrentSubscription`
 * but targets one row instead of the end-user's "current" one, so it's
 * unambiguous when a user has more than one subscription. The subscription
 * MUST belong to `application` (the caller resolves the application within
 * the operator's tenant first), so this can't reach across workspaces.
 */
export async function cancelSubscriptionById(
  application: Application,
  subscriptionId: string,
  opts?: { atPeriodEnd?: boolean; /** The operator cancelling, named as the actor in the billing log. */ operatorId?: string },
): Promise<Subscription> {
  const actor = { type: 'operator', ...(opts?.operatorId !== undefined && { id: opts.operatorId }) } as const;
  const sub = await prisma.subscription.findFirst({
    where: { id: subscriptionId, applicationId: application.id },
  });
  if (!sub) {
    throw new RekeyError({
      statusCode: 404,
      code: 'SUBSCRIPTION_NOT_FOUND',
      message: `Subscription "${subscriptionId}" not found in this application.`,
      fix: 'List subscriptions and use an id this application owns.',
    });
  }
  if (sub.status === 'CANCELED' || sub.status === 'EXPIRED') return sub;

  const providerBacked = Boolean(sub.provider && sub.providerSubId);
  // NOT `cancelEffect`, this path deliberately still requires a
  // provider. It used to also require `providerBacked`, on the stated ground
  // that a provider-less row scheduled from here could sit ACTIVE and
  // entitling indefinitely if nobody ever loaded that user's portal, because
  // only `getCurrentSubscription` reaped it, and that "relaxing it needs the
  // expiry seam widened past getCurrentSubscription first".
  //
  // That seam has since been widened. `stillEntitling` filters
  // `cancelAt` in the entitlement query itself, so a scheduled cancellation
  // stops entitling on the date whether or not anybody reads the row.
  //
  // Keeping the old gate is no longer cautious, it is just wrong, and it is
  // wrong against the buyer: on a deployment where subscriptions are granted
  // rather than checked out, `providerBacked` is false for every one of them,
  // so an operator pressing cancel ended the subscription immediately,
  // mid-period, with no refund and entitlements gone the same second, while
  // the self-service path on the identical row cancelled at period end. Two
  // operator-visible cancels disagreeing about the same subscription.
  //
  // `cancelEffect` is the shared answer to "what would cancelling now do",
  // and the self-service path already uses it.
  const atPeriodEnd = opts?.atPeriodEnd !== false && cancelEffect(sub) === 'period-end';

  // Idempotent: already scheduled to cancel at period end.
  if (atPeriodEnd && sub.cancelAt !== null) return sub;

  if (providerBacked) {
    const provider = await getProviderForApplication(
      application,
      sub.provider as BillingProviderName,
    );
    // Operator-facing (cancel-by-id from the panel): they own the credential,
    // so they get the provider's own message, framed.
    await withProviderErrors(
      {
        provider: sub.provider as string,
        operation: 'subscription cancellation',
        audience: 'operator',
      },
      () => provider.cancelSubscription({ subscription: sub, atPeriodEnd }),
    );
  }

  if (atPeriodEnd) {
    return prisma.$transaction(async (tx) => {
      const scheduled = await tx.subscription.update({
        where: { id: sub.id },
        data: { cancelAt: sub.currentPeriodEnd },
      });
      await logSubscriptionCanceled(tx, sub.id, { atPeriodEnd: true, cause: 'operator' }, { actor });
      return scheduled;
    });
  }

  // Same transactional cancel + announce as cancelCurrentSubscription.
  const now = new Date();
  const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
    const row = await tx.subscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
    });
    await logSubscriptionCanceled(tx, row.id, { atPeriodEnd: false, cause: 'operator' }, { actor });
    return {
      updated: row,
      deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.canceled', row.id),
    };
  });
  kickDeliveries(deliveryIds);
  const { dunningService } = await import('./dunning.service.js');
  await dunningService.closeForCanceledSubscription(updated.id);
  return updated;
}

/**
 * Cancel every still-billing provider subscription belonging to an end-user.
 * Used by the operator end-user delete / GDPR-erasure paths so the provider
 * (Stripe/PayPal/Razorpay) stops billing a row we are about to remove or
 * tombstone, otherwise the provider keeps charging a vanished user.
 *
 * Cancels immediately (`atPeriodEnd: false`) at the provider for each
 * ACTIVE/PAST_DUE subscription that has a provider-side id. Same
 * `BillingProvider.cancelSubscription` path the portal cancel + dunning
 * exhaustion use. BEST-EFFORT: a provider error must NOT block the
 * delete/erase, we log and continue, so the user is always removed. The
 * local row's status is intentionally left untouched (the delete/erase
 * caller removes or tombstones it next).
 *
 * Returns the count of subscriptions for which a provider cancel was
 * attempted (for the audit metadata).
 */
export async function cancelActiveProviderSubscriptionsForEndUser(args: {
  application: Application;
  endUserId: string;
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<{ attempted: number; failed: number }> {
  const subs = await prisma.subscription.findMany({
    where: {
      applicationId: args.application.id,
      endUserId: args.endUserId,
      // TRIALING too: a trial converts into a charge, so leaving one
      // running at the provider bills a user we have just erased.
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      provider: { not: null },
      providerSubId: { not: null },
    },
  });
  let attempted = 0;
  let failed = 0;
  for (const sub of subs) {
    // An inbound-only provider cannot be asked to stop; the sender learns
    // of the deletion from `user.deleted` / `user.erased` and stops on its
    // side. Locally the row is ended now, so the erased account does not
    // sit in the active-subscription counts until the sender catches up.
    if (isInboundOnlyProvider(sub.provider)) {
      const now = new Date();
      const deliveryIds = await prisma.$transaction(async (tx) => {
        const { count } = await tx.subscription.updateMany({
          where: { id: sub.id, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
          data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
        });
        if (count === 0) return [];
        await logSubscriptionCanceled(tx, sub.id, { atPeriodEnd: false, cause: 'system' }, { actor: { type: 'system' } });
        return enqueueSubscriptionEvent(tx, 'subscription.canceled', sub.id);
      });
      kickDeliveries(deliveryIds);
      continue;
    }
    attempted += 1;
    try {
      const provider = await getProviderForApplication(
        args.application,
        sub.provider as BillingProviderName,
      );
      await provider.cancelSubscription({ subscription: sub, atPeriodEnd: false });
    } catch (err) {
      failed += 1;
      args.log?.warn(
        { err, subscriptionId: sub.id, provider: sub.provider },
        'end-user delete/erase: provider-side subscription cancel failed (continuing)',
      );
    }
  }
  return { attempted, failed };
}
