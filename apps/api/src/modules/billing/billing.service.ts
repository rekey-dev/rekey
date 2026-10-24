/**
 * Billing service, public surface used by `@rekey.dev/node`.
 *
 * Core operations:
 *   - listActivePlans(application)        → public plan catalogue
 *   - getCurrentSubscription(app, eu)     → that user's active sub, if any
 *   - createCheckoutSession(app, eu, slug, urls) → returns provider URL
 *
 * Plus the self-service reads and the cancel path the hosted portal drives,
 * see the exported object at the bottom of the file for the full list.
 *
 * Subscription activation, payment recording, and status transitions all
 * happen via webhook events from the provider, *not* synchronously here.
 * The local `Subscription` row is created in `PENDING` state at checkout
 * and flips to `ACTIVE` when the webhook fires (see the provider modules'
 * `translate` + the shared appliers in `webhooks/apply.ts`).
 *
 * The one exception is a deliberate super-admin GRANT, a sale settled by
 * invoice, bank transfer or fiat of the deployment owner, where no provider
 * event is ever coming. That lives in `grant.service.ts` and goes through the
 * same provisioner and the same outbox, so everything downstream of an
 * activation still happens. It never runs from this file.
 */

import { openCheckout } from './checkout/open.js';
import {
  cancelActiveProviderSubscriptionsForEndUser,
  cancelCurrentSubscription,
  cancelSubscriptionById,
} from './subscription-cancel.js';
import type { Application, EndUser, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { costsNothing } from './free-plan.js';
import { isOneTimePlan } from './plan-kind.js';
import { plansService } from '../plans/plans.service.js';

import { getModule } from './providers/registry.js';
import { isEntitlingStatus } from '@rekey.dev/shared-types';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { WITH_DEFAULT_PRICE, withDefaultPrices, type PlanWithDefaultPrice } from '../plans/default-price.js';
/**
 * End-user-facing payment row (GET /api/v1/billing/payments). A deliberate
 * projection, internal correlation ids (providerPaymentId) and raw metadata
 * stay server-side; `receiptUrl` is surfaced when a provider receipt link was
 * stamped onto the payment's metadata (`receiptUrl` / `receipt_url`).
 */
export interface EndUserPaymentDto {
  id: string;
  amount: number;
  currency: string;
  // Mirrors the Prisma enum. `PARTIALLY_REFUNDED` is deliberately visible to
  // the end user: a buyer looking at their own payment history should be able
  // to see that some of a charge came back, and showing it as SUCCEEDED or as
  // REFUNDED would each be wrong in a way that costs them a support ticket.
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  /** How much of `amount` has been refunded, smallest currency unit. The buyer's own money. */
  refundedAmount: number;
  description: string | null;
  createdAt: Date;
  subscriptionId: string | null;
  /** Slug of the plan the payment's subscription is on, when resolvable. */
  planSlug: string | null;
  /** Provider-hosted receipt URL, when present in the payment metadata. */
  receiptUrl: string | null;
}

/** Pull a usable https receipt link out of a payment's metadata, if any. */
function receiptUrlFromMetadata(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const candidate = m.receiptUrl ?? m.receipt_url;
  if (typeof candidate !== 'string') return null;
  // Only http(s) links leave the API, a metadata key is operator-writable,
  // so refuse javascript:/data: and other schemes outright.
  return /^https?:\/\//i.test(candidate) ? candidate : null;
}

/**
 * Terminate a subscription whose scheduled cancellation date has passed.
 *
 * A subscription with NO provider record has no termination event coming, so
 * before this existed, scheduling one to cancel at period end left it `ACTIVE`
 * forever and the buyer kept paid entitlements for nothing. Allowing period-end
 * scheduling without a provider (see `cancelCurrentSubscription`) is only
 * correct because of this.
 *
 * ## Provider-backed rows expire here too
 *
 * This used to refuse them outright, the provider's webhook was the source of
 * truth and this must not race it. That reasoning assumed every provider can
 * schedule a cancellation. PayPal cannot: its only cancel is immediate, so a
 * period-end request cancels the agreement now and the paid period is held open
 * locally instead (see `applySubscriptionStatusMirror`, which declines to let
 * PayPal's own CANCELLED event shorten it). Nothing else would ever end those
 * rows, PayPal has already said everything it is going to say about that
 * subscription, so they would stay ACTIVE and entitled indefinitely.
 *
 * Racing the provider is safe in the direction that matters. Both sides write
 * the same terminal state, and the `status: 'ACTIVE'` guard below means only
 * one of them wins and only one `subscription.canceled` is announced. What this
 * cannot do is drop entitlements while money is still moving: the cancellation
 * was confirmed by the provider before `cancelAt` was ever written (the cancel
 * call throws on failure and the row is left alone), so a `cancelAt` in the
 * past means billing has already stopped.
 *
 * Lazy rather than scheduled, deliberately: the row is read on every
 * entitlement resolution and every portal load, so the expiry happens the
 * first time anyone asks, no new job, no new Redis key, nothing to run in a
 * self-host that has neither. The cost is that a subscription nobody looks at
 * stays nominally ACTIVE in the table until someone does, which is invisible
 * because nothing consults it in the meantime, and, since the provider-side
 * cancellation already happened, costs the operator a little unbilled access
 * rather than costing the buyer a charge.
 *
 * The update is conditional on the row still being ACTIVE, so two concurrent
 * readers cannot both flip it and emit two `subscription.canceled` events,
 * `updateMany` reports how many rows it actually changed, and only the winner
 * enqueues.
 */
/** A provider that only receives events and can be asked for nothing. */
function isInboundOnlyProvider(provider: string | null): boolean {
  return provider !== null && getModule(provider)?.capabilities.checkout === false;
}

async function expireIfDue(sub: Subscription): Promise<Subscription> {
  const now = new Date();

  const dueLocally = sub.status === 'ACTIVE' && sub.cancelAt !== null && sub.cancelAt <= now;
  if (!dueLocally) {
    // A granted term that has run out. Same lazy seam, different fact.
    //
    // `grantSubscription` writes no provider and a `currentPeriodEnd`, and
    // nothing will ever renew that row, so an elapsed term is final. Entitlement
    // resolution already stops honouring it (see `stillEntitling`), but the row
    // itself stayed ACTIVE, leaving the panel and the portal reporting an
    // active subscription to someone who has no access, which reads as a bug in
    // the entitlement check rather than a term that ended.
    //
    // Provider-backed rows are exempt for the same reason as in resolution:
    // there `currentPeriodEnd` is a renewal date that a late webhook moves
    // forward, and expiring on it would end a subscription the buyer has just
    // paid for.
    //
    // Checked AFTER `cancelAt`, deliberately. A subscription whose scheduled
    // cancellation has come due is CANCELED, somebody cancelled it, and a
    // grant carries a `currentPeriodEnd` too, so testing the term first
    // relabelled every cancelled grant as EXPIRED. The more specific fact wins.
    //
    // No event is emitted. `subscription.expired` does not exist in the webhook
    // catalogue, and inventing one here would add a public surface from inside a
    // lazy read; the licence service sets EXPIRED the same way. Announcing it is
    // a separate, deliberate change.
    const termElapsed =
      sub.status === 'ACTIVE' &&
      sub.providerSubId === null &&
      sub.currentPeriodEnd !== null &&
      sub.currentPeriodEnd <= now;
    if (termElapsed) {
      const { count } = await prisma.subscription.updateMany({
        where: { id: sub.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      if (count > 0) return row;
      // Someone else got there first; return whatever they wrote.
      return row;
    }
    return sub;
  }

  // Money that arrived AFTER the cancellation date means this subscription was
  // restarted, not left to lapse, do not expire it, clear the stale date.
  //
  // "ACTIVE with a `cancelAt` in the past" has two causes and the row alone
  // cannot tell them apart: a scheduled cancellation whose date has come, and a
  // resubscribe that reused the cancelled row (unique on
  // `(applicationId, endUserId, planId)`) and carried the old date forward.
  // Reactivation now clears `cancelAt` at every seam, so new rows cannot reach
  // the second state, but rows POISONED BEFORE THIS SHIPPED still exist, and
  // to them the expiry above would look overdue. It would then cancel a
  // subscription the buyer had paid for, on the next portal load, which is the
  // very harm this work exists to stop.
  //
  // A succeeded payment dated after `cancelAt` is an unambiguous signal. No
  // genuinely lapsing subscription takes another payment past its end: PayPal's
  // agreement is cancelled outright at request time, Stripe's
  // `cancel_at_period_end` bills nothing after the period, and a row with no
  // provider never charges at all.
  //
  // Not for a subscription an inbound-only provider created. Its payments are
  // bookkeeping the sender posts on its own schedule, so a charge recorded
  // after the cancellation date says nothing about whether the subscription
  // was restarted; a sender that restarts one says so with an activation
  // carrying a later period end, which clears the schedule explicitly.
  const paidSinceCancellation = isInboundOnlyProvider(sub.provider)
    ? null
    : await prisma.payment.findFirst({
        where: { subscriptionId: sub.id, status: 'SUCCEEDED', createdAt: { gt: sub.cancelAt! } },
        select: { id: true },
      });
  if (paidSinceCancellation) {
    return prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAt: null, canceledAt: null, cancelReason: null, cancelFeedback: null },
    });
  }

  const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
    const { count } = await tx.subscription.updateMany({
      where: { id: sub.id, status: 'ACTIVE' },
      data: { status: 'CANCELED', canceledAt: now },
    });
    if (count === 0) {
      // Someone else got there first. Return their result, announce nothing.
      return { updated: await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } }), deliveryIds: [] as string[] };
    }
    const row = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    return {
      updated: row,
      deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.canceled', row.id),
    };
  });
  if (deliveryIds.length > 0) {
    kickDeliveries(deliveryIds);
    const { dunningService } = await import('./dunning.service.js');
    await dunningService.closeForCanceledSubscription(updated.id);
  }
  return updated;
}

type SubscriptionSubject = { beneficiaryOrgId: string } | { endUserId: string; beneficiaryOrgId: null };

function subscriptionSubject(endUser: Pick<EndUser, 'id'>, organizationId: string | undefined): SubscriptionSubject {
  return organizationId
    ? { beneficiaryOrgId: organizationId }
    : { endUserId: endUser.id, beneficiaryOrgId: null };
}

/** Live rows read per subject. A subject holds at most one row per plan. */
export const LIVE_SUBSCRIPTIONS_CAP = 100;

/**
 * The subject's ACTIVE, TRIALING and PAST_DUE rows in the order
 * `getCurrentSubscription` considers them: recurring paid plans, then one-time
 * plans (a credit pack, a perpetual licence), then the free fallback, newest
 * `createdAt` first within each, `id` descending on a tie. A one-time purchase
 * ranks below a recurring plan so buying a pack never displaces the
 * subscription the buyer is on.
 * At most the newest {@link LIVE_SUBSCRIPTIONS_CAP} rows are considered.
 *
 * Newest rather than dearest: two plans can be priced in different currencies
 * or intervals, so "highest price" is not a total order, and changing the pick
 * would move which row an existing integration's cancel call ends.
 */
async function rankedLiveSubscriptions(
  application: Application,
  subject: SubscriptionSubject,
): Promise<Subscription[]> {
  const liveRows = await prisma.subscription.findMany({
    where: {
      applicationId: application.id,
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      ...subject,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: LIVE_SUBSCRIPTIONS_CAP,
  });
  if (liveRows.length === 0) return [];
  // A row counts as the fallback when its plan costs nothing, whether or not
  // it is today's `defaultPlanSlug`: renaming or clearing the default must not
  // bring the shadowing back for buyers still holding the old $0 rows, and a
  // priced plan stored as the default is still something the buyer pays for.
  const plans = await withDefaultPrices(
    await prisma.plan.findMany({
      where: { id: { in: [...new Set(liveRows.map((row) => row.planId))] } },
      include: WITH_DEFAULT_PRICE,
    }),
  );
  const fallbackPlanIds = new Set(plans.filter((plan) => costsNothing(plan)).map((plan) => plan.id));
  const oneTimePlanIds = new Set(plans.filter((plan) => isOneTimePlan(plan)).map((plan) => plan.id));
  const rank = (row: Subscription): number =>
    fallbackPlanIds.has(row.planId) ? 2 : oneTimePlanIds.has(row.planId) ? 1 : 0;
  return [0, 1, 2].flatMap((group) => liveRows.filter((row) => rank(row) === group));
}

export const billingService = {
  async listActivePlans(
    application: Application,
    opts?: { take?: number; skip?: number },
  ): Promise<PlanWithDefaultPrice[]> {
    return plansService.listForApplication(application.id, false, opts);
  },

  /** Total plans in the public catalogue, ignoring take/skip. */
  async countActivePlans(application: Application): Promise<number> {
    return plansService.countForApplication(application.id, false);
  },

  /**
   * Every live subscription of the caller (or of `opts.organizationId`), in the
   * order `getCurrentSubscription` ranks them, so the first item is what the
   * singular read returns whenever a live one exists. Rows that lapse on this
   * read are settled by the same lazy expiry and left out.
   */
  async listLiveSubscriptions(
    application: Application,
    endUser: Pick<EndUser, 'id'>,
    opts?: { organizationId?: string },
  ): Promise<Subscription[]> {
    const ranked = await rankedLiveSubscriptions(application, subscriptionSubject(endUser, opts?.organizationId));
    const live: Subscription[] = [];
    for (const row of ranked) {
      const read = await expireIfDue(row);
      if (isEntitlingStatus(read.status)) live.push(read);
    }
    return live;
  },

  /**
   * The active subscription for the caller, their own by default, or an
   * organization's when `opts.organizationId` is given (org-billed apps). The
   * caller's membership/role is checked at the route layer before this runs.
   *
   * ## `includeEnded`
   *
   * Off, this answers "what are they on right now" and returns null once a
   * subscription reaches CANCELED or EXPIRED. That made a paid customer's
   * history unrecoverable: a portal reading this a day after a cancellation
   * got the same `null` as someone who had never subscribed at all, and could
   * only say "you are on the free plan", no plan, no end date, no way back.
   * The only record was the cancel call's own response, which is gone as soon
   * as the page reloads.
   *
   * On, it falls back to the most recent ENDED subscription **when and only
   * when the answer would otherwise have been null**. That bound is the whole
   * contract: the flag can turn a null into a row, and can never change a
   * non-null answer. A caller that resubscribed still gets the live
   * subscription, not the one they cancelled last year, and no existing
   * entitlement check can be made wrong by passing it.
   *
   * The fallback is an explicit CANCELED/EXPIRED list rather than "anything
   * not active". A status this version has never heard of is not evidence that
   * a subscription ended, and reporting one as history is the more damaging
   * guess of the two.
   */
  async getCurrentSubscription(
    application: Application,
    endUser: EndUser,
    opts?: { organizationId?: string; includeEnded?: boolean },
  ): Promise<Subscription | null> {
    // `beneficiaryOrgId: null` is load-bearing. `endUserId` is required on every
    // Subscription, so an org-beneficiary row also carries the buyer's personal
    // id; without this the org row matches a personal lookup, and the query is
    // newest-first, so the org purchase shadows the buyer's own subscription.
    // Callers that cancel what this returns would then cancel the org's.
    // `createCheckoutSession` has always scoped its own lookup this way.
    const subject = subscriptionSubject(endUser, opts?.organizationId);

    // Entitled rows first, and only then an unpaid checkout. Newest-first
    // across all four statuses let a PENDING row shadow a live plan: a free
    // subscriber who opened a paid checkout and closed the tab read as
    // "pending" from then on, every entitlement gate built on this answer
    // refused them, and a cancel aimed at their plan landed on the abandoned
    // checkout instead. A checkout nobody finished is not what somebody is on.
    //
    // TRIALING is live: omitting it would show a trialist no subscription at
    // all, on the page whose whole job is to say what they are on.
    //
    // Among live rows, a free plan is the fallback, never the answer while
    // anything else is live, a one-time purchase never outranks a recurring
    // plan, and among several in one group the newest wins (see
    // `rankedLiveSubscriptions`; `listLiveSubscriptions` returns them all).
    // Recency cannot
    // decide it: checkout reuses the (app, end-user, plan) row, so a buyer who
    // opened a paid checkout, backed out, joined the free tier and paid later
    // holds a paid row CREATED before the free one. Newest-first read them as
    // free, offered the upgrade they had already bought, and cancelled the
    // free row while the paid one kept billing.
    //
    // A row that lapses on this very read (`expireIfDue`) does not end the
    // search either, or the first read after a paid term ends would report
    // "ended" while the free tier is still live underneath it.
    const ranked = await rankedLiveSubscriptions(application, subject);
    let lapsed: Subscription | undefined;
    for (const row of ranked) {
      const read = await expireIfDue(row);
      if (isEntitlingStatus(read.status)) return read;
      lapsed ??= read;
    }
    // Everything live lapsed on this read. Report the one that mattered
    // most, as the single-row version of this always did.
    if (lapsed) return lapsed;

    const pending = await prisma.subscription.findFirst({
      where: { applicationId: application.id, status: 'PENDING', ...subject },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) return pending;
    if (!opts?.includeEnded) return null;

    // Newest first by `createdAt`, matching the live query: for someone who
    // subscribed, cancelled, subscribed again and cancelled again, the honest
    // "what happened to your subscription" is the most recent one they took
    // out, not the oldest row that happens to carry a canceledAt.
    return prisma.subscription.findFirst({
      where: {
        applicationId: application.id,
        status: { in: ['CANCELED', 'EXPIRED'] },
        ...subject,
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Open a checkout for an end user against a named plan. See `checkout-create.ts`. */
  createCheckoutSession: openCheckout,

  /**
   * The calling end-user's OWN payment history, newest first. Strictly
   * scoped by `(applicationId, endUserId)`, there is no way to read another
   * user's rows through this surface. Org-billed subscriptions keep the
   * owner as the payer (`Payment.endUserId`), so an org owner sees those
   * payments here too.
   */
  async listPaymentsForEndUser(
    application: Application,
    endUserId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ items: EndUserPaymentDto[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const where = { applicationId: application.id, endUserId };
    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { subscription: { select: { plan: { select: { slug: true } } } } },
      }),
      prisma.payment.count({ where }),
    ]);
    return {
      items: rows.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        refundedAmount: p.refundedAmount,
        description: p.description,
        createdAt: p.createdAt,
        subscriptionId: p.subscriptionId,
        planSlug: p.subscription?.plan.slug ?? null,
        receiptUrl: receiptUrlFromMetadata(p.metadata),
      })),
      total,
      limit,
      offset,
    };
  },

  /**
   * One subscription of the subject by id, or null when it belongs to anybody
   * else. A live row goes through the same lazy expiry as every other read.
   */
  async findOwnSubscription(
    application: Application,
    endUser: Pick<EndUser, 'id'>,
    subscriptionId: string,
    organizationId: string | undefined,
  ): Promise<Subscription | null> {
    const row = await prisma.subscription.findFirst({
      where: { id: subscriptionId, applicationId: application.id, ...subscriptionSubject(endUser, organizationId) },
    });
    return row && (await expireIfDue(row));
  },

  /** Cancel the caller's subscription, now or at period end. See `subscription-cancel.ts`. */
  cancelCurrentSubscription,
  /** Cancel one subscription by id, as an operator. */
  cancelSubscriptionById,
  /** Stop provider billing for every subscription of an end user being deleted. */
  cancelActiveProviderSubscriptionsForEndUser,
};
