/**
 * Billing service — public surface used by `@rekey.dev/node`.
 *
 * Core operations:
 *   - listActivePlans(application)        → public plan catalogue
 *   - getCurrentSubscription(app, eu)     → that user's active sub, if any
 *   - createCheckoutSession(app, eu, slug, urls) → returns provider URL
 *
 * Plus the self-service reads and the cancel path the hosted portal drives —
 * see the exported object at the bottom of the file for the full list.
 *
 * Subscription activation, payment recording, and status transitions all
 * happen via webhook events from the provider — *not* synchronously here.
 * The local `Subscription` row is created in `PENDING` state at checkout
 * and flips to `ACTIVE` when the webhook fires (see the provider modules'
 * `translate` + the shared appliers in `webhooks/apply.ts`).
 *
 * The one exception is a deliberate super-admin GRANT — a sale settled by
 * invoice, bank transfer or fiat of the deployment owner, where no provider
 * event is ever coming. That lives in `grant.service.ts` and goes through the
 * same provisioner and the same outbox, so everything downstream of an
 * activation still happens. It never runs from this file.
 */

import type { Application, EndUser, Plan, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { providerError, withProviderErrors } from '../../lib/provider-errors.js';
import { plansService } from '../plans/plans.service.js';
import { couponsService } from '../coupons/coupons.service.js';
import { resolveCheckoutDiscount } from './checkout-discount.js';
import { resolveCheckoutTrial } from './checkout-trial.js';
import {
  buildCheckoutSessionMetadata,
  CHECKOUT_SESSION_LIFETIME_MS,
} from './checkout-sessions.js';
import { getProviderForApplication, pickProvider } from './providers/index.js';
import type { BillingProviderName } from './credentials.service.js';
import { BillingConfigSchema, cancelEffect, isEntitlingStatus, ENTITLING_SUBSCRIPTION_STATUSES } from '@rekey.dev/shared-types';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';

/**
 * End-user-facing payment row (GET /api/v1/billing/payments). A deliberate
 * projection — internal correlation ids (providerPaymentId) and raw metadata
 * stay server-side; `receiptUrl` is surfaced when a provider receipt link was
 * stamped onto the payment's metadata (`receiptUrl` / `receipt_url`).
 */
export interface EndUserPaymentDto {
  id: string;
  amount: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  description: string | null;
  createdAt: Date;
  subscriptionId: string | null;
  /** Slug of the plan the payment's subscription is on, when resolvable. */
  planSlug: string | null;
  /** Provider-hosted receipt URL, when present in the payment metadata. */
  receiptUrl: string | null;
}

/**
 * Statuses that mean the buyer is currently paying for this subscription.
 *
 * PAST_DUE is included: the dunning window exists precisely so a failed charge
 * does not immediately revoke what has been bought, and the portal treats it
 * as entitled too. Only these are protected from being reset by a new checkout.
 */
function isEntitled(status: Subscription['status'] | undefined): boolean {
  return isEntitlingStatus(status);
}

/** Pull a usable https receipt link out of a payment's metadata, if any. */
function receiptUrlFromMetadata(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const candidate = m.receiptUrl ?? m.receipt_url;
  if (typeof candidate !== 'string') return null;
  // Only http(s) links leave the API — a metadata key is operator-writable,
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
 * This used to refuse them outright — the provider's webhook was the source of
 * truth and this must not race it. That reasoning assumed every provider can
 * schedule a cancellation. PayPal cannot: its only cancel is immediate, so a
 * period-end request cancels the agreement now and the paid period is held open
 * locally instead (see `applySubscriptionStatusMirror`, which declines to let
 * PayPal's own CANCELLED event shorten it). Nothing else would ever end those
 * rows — PayPal has already said everything it is going to say about that
 * subscription — so they would stay ACTIVE and entitled indefinitely.
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
 * first time anyone asks — no new job, no new Redis key, nothing to run in a
 * self-host that has neither. The cost is that a subscription nobody looks at
 * stays nominally ACTIVE in the table until someone does, which is invisible
 * because nothing consults it in the meantime — and, since the provider-side
 * cancellation already happened, costs the operator a little unbilled access
 * rather than costing the buyer a charge.
 *
 * The update is conditional on the row still being ACTIVE, so two concurrent
 * readers cannot both flip it and emit two `subscription.canceled` events —
 * `updateMany` reports how many rows it actually changed, and only the winner
 * enqueues.
 */
async function expireIfDue(sub: Subscription): Promise<Subscription> {
  const now = new Date();

  const dueLocally = sub.status === 'ACTIVE' && sub.cancelAt !== null && sub.cancelAt <= now;
  if (!dueLocally) {
    // A granted term that has run out. Same lazy seam, different fact.
    //
    // `grantSubscription` writes no provider and a `currentPeriodEnd`, and
    // nothing will ever renew that row, so an elapsed term is final. Entitlement
    // resolution already stops honouring it (see `stillEntitling`), but the row
    // itself stayed ACTIVE — leaving the panel and the portal reporting an
    // active subscription to someone who has no access, which reads as a bug in
    // the entitlement check rather than a term that ended.
    //
    // Provider-backed rows are exempt for the same reason as in resolution:
    // there `currentPeriodEnd` is a renewal date that a late webhook moves
    // forward, and expiring on it would end a subscription the buyer has just
    // paid for.
    //
    // Checked AFTER `cancelAt`, deliberately. A subscription whose scheduled
    // cancellation has come due is CANCELED — somebody cancelled it — and a
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
  // restarted, not left to lapse — do not expire it, clear the stale date.
  //
  // "ACTIVE with a `cancelAt` in the past" has two causes and the row alone
  // cannot tell them apart: a scheduled cancellation whose date has come, and a
  // resubscribe that reused the cancelled row (unique on
  // `(applicationId, endUserId, planId)`) and carried the old date forward.
  // Reactivation now clears `cancelAt` at every seam, so new rows cannot reach
  // the second state — but rows POISONED BEFORE THIS SHIPPED still exist, and
  // to them the expiry above would look overdue. It would then cancel a
  // subscription the buyer had paid for, on the next portal load, which is the
  // very harm this work exists to stop.
  //
  // A succeeded payment dated after `cancelAt` is an unambiguous signal. No
  // genuinely lapsing subscription takes another payment past its end: PayPal's
  // agreement is cancelled outright at request time, Stripe's
  // `cancel_at_period_end` bills nothing after the period, and a row with no
  // provider never charges at all.
  const paidSinceCancellation = await prisma.payment.findFirst({
    where: { subscriptionId: sub.id, status: 'SUCCEEDED', createdAt: { gt: sub.cancelAt! } },
    select: { id: true },
  });
  if (paidSinceCancellation) {
    return prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAt: null, canceledAt: null },
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

export const billingService = {
  async listActivePlans(
    application: Application,
    opts?: { take?: number; skip?: number },
  ): Promise<Plan[]> {
    return plansService.listForApplication(application.id, false, opts);
  },

  /** Total plans in the public catalogue, ignoring take/skip. */
  async countActivePlans(application: Application): Promise<number> {
    return plansService.countForApplication(application.id, false);
  },

  /**
   * The active subscription for the caller — their own by default, or an
   * organization's when `opts.organizationId` is given (org-billed apps). The
   * caller's membership/role is checked at the route layer before this runs.
   *
   * ## `includeEnded`
   *
   * Off, this answers "what are they on right now" and returns null once a
   * subscription reaches CANCELED or EXPIRED. That made a paid customer's
   * history unrecoverable: a portal reading this a day after a cancellation
   * got the same `null` as someone who had never subscribed at all, and could
   * only say "you are on the free plan" — no plan, no end date, no way back.
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
    const subject = opts?.organizationId
      ? { beneficiaryOrgId: opts.organizationId }
      : { endUserId: endUser.id };

    const sub = await prisma.subscription.findFirst({
      where: {
        applicationId: application.id,
        // TRIALING is live: omitting it would show a trialist no subscription
        // at all, on the page whose whole job is to say what they are on.
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'PENDING'] },
        ...subject,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (sub) return expireIfDue(sub);
    if (!opts?.includeEnded) return null;

    // Newest first by `createdAt`, matching the live query: for someone who
    // subscribed, cancelled, subscribed again and cancelled again, the honest
    // "what happened to your subscription" is the most recent one they took
    // out — not the oldest row that happens to carry a canceledAt.
    return prisma.subscription.findFirst({
      where: {
        applicationId: application.id,
        status: { in: ['CANCELED', 'EXPIRED'] },
        ...subject,
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Create a checkout session for an end-user against a named plan. Returns
   * the provider's hosted URL and a local PENDING Subscription row.
   *
   * The Subscription row is created locally so we can correlate the
   * eventual webhook back to it; the provider's session id lives on
   * `Subscription.metadata.checkoutSessionId`.
   */
  async createCheckoutSession(input: {
    application: Application;
    endUser: EndUser;
    planSlug: string;
    successUrl: string;
    cancelUrl: string;
    /** Optional coupon code to apply at checkout. Validated, and its redemption
     *  slot RESERVED before the provider mints the discount. */
    couponCode?: string;
    /**
     * End-user's chosen provider. When omitted, the geo router picks one
     * from the configured set using `country` and the per-provider
     * `countries`/`priority` settings.
     */
    provider?: BillingProviderName;
    /** ISO 3166-1 alpha-2, used by the geo router when `provider` is absent. */
    country?: string;
    /** Beneficiary org (owner+beneficiary). The route asserts the caller is an
     *  OWNER/ADMIN of it before passing it here. Null/absent = bill the owner. */
    beneficiaryOrgId?: string;
  }): Promise<{
    url: string;
    subscription: Subscription;
    /** Discount applied (smallest currency unit). 0 when no coupon was given. */
    discountAmount: number;
    /** Which provider issued this checkout. Stamped on the Subscription row. */
    provider: BillingProviderName;
  }> {
    // When the Application bills per organization (owner+beneficiary), a
    // checkout MUST name a beneficiary org — an individual can't hold the sub.
    // Surface a clear hint instead of silently creating a user-subject sub
    // (the mistake an AI agent / new integrator makes first).
    const billingConfig = BillingConfigSchema.parse(input.application.billingConfig);
    if (billingConfig.billingSubject === 'org' && input.beneficiaryOrgId === undefined) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_ORGANIZATION_REQUIRED',
        message: 'This Application bills per organization, but no organization was provided for checkout.',
        fix: 'Pass `organizationId` of a team the user OWNS or ADMINS (set the session\'s active org via organizations.switch, or pass organizationId to createCheckout). Change the model in Panel → Application → Billing → Subject.',
      });
    }

    const plan = await plansService.getBySlug(input.application.id, input.planSlug);
    if (!plan.active) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_INACTIVE',
        message: `Plan "${input.planSlug}" is not currently available for new sign-ups.`,
        fix: 'Pick a different active plan, or have an admin re-enable this one via PATCH /api/v1/admin/applications/:id/plans/:slug.',
      });
    }

    // CREDIT packs + perpetual (non-TIMED) licenses are one-off purchases —
    // route them through the provider's one-time payment flow so they DON'T
    // create a recurring subscription. TIMED licenses + SUBSCRIPTION plans
    // recur. Fulfillment (credit grant / license issue) still lands on the
    // payment-completed webhook either way.
    const isOneTime =
      plan.kind === 'CREDIT' || (plan.kind === 'LICENSE' && plan.licenseKind !== 'TIMED');

    let couponContext: { couponId: string; code: string; discountAmount: number } | null = null;
    if (input.couponCode) {
      const validated = await couponsService.validate({
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        code: input.couponCode,
        planSlug: plan.slug,
        amount: plan.amount,
        currency: plan.currency,
      });
      couponContext = {
        couponId: validated.coupon.id,
        code: validated.coupon.code,
        discountAmount: validated.discountAmount,
      };
    }

    // Which processor this buyer is ALREADY paying through, if any.
    //
    // Resolved before the router runs, because it outranks the router. A
    // subscription's provider is immutable for its lifetime, so a buyer who
    // holds one and starts a second checkout somewhere else does not get a
    // changed subscription: they get a SECOND one, and two charges a month.
    //
    // Scoped to the whole Application and not to this plan. The guard that used
    // to sit further down keyed on (application, endUser, PLAN), which only ever
    // caught re-buying the identical plan. The case that bills twice is the
    // ordinary one: on `basic` through PayPal, upgrade to `pro`, get routed to
    // Stripe. Different planId, guard missed, two live subscriptions.
    //
    // TWO KEYS ARE MATCHED, and they guard different things, which is why the
    // old plan-keyed comparison was not redundant and both belong in here:
    //
    //   * the SUBJECT. An org-billed subscription belongs to the org, not to
    //     whoever happens to be checking out for it. This is what catches the
    //     second billing relationship.
    //   * the ROW THIS CHECKOUT WILL WRITE, keyed `(applicationId, endUserId,
    //     planId)` by the upsert below, which does NOT include
    //     `beneficiaryOrgId`. When the two disagree, guarding only by subject
    //     inspects one row and writes another: a personal PayPal subscription
    //     on `pro` plus an org checkout of `pro` through Stripe answered 200,
    //     flipped `provider` to stripe and left the PayPal `providerSubId` in
    //     place. PayPal kept charging and nothing local pointed at it.
    //
    // The real fix for the second one is `beneficiaryOrgId` in the uniqueness
    // constraint, which ORG_BILLING.md §5 already flags. Until that migration
    // exists the guard covers both keys.
    const boundSubject =
      input.beneficiaryOrgId !== undefined
        ? { beneficiaryOrgId: input.beneficiaryOrgId }
        : { endUserId: input.endUser.id, beneficiaryOrgId: null };
    const bound = isOneTime
      ? null
      : await prisma.subscription.findFirst({
          where: {
            applicationId: input.application.id,
            provider: { not: null },
            // One-off purchases neither bind nor are bound. A CREDIT pack or a
            // perpetual licence is a single charge that creates no second
            // billing relationship, so refusing over one would block a
            // legitimate sale to defend against a problem it cannot cause.
            // `applyCheckoutCompleted` also writes one-time rows ACTIVE with no
            // period, so they stay ACTIVE forever and would pin a buyer to
            // whichever processor sold them a $5 credit pack once. Stated as
            // the recurring kinds rather than as a negation so it cannot go
            // quietly wrong on a NULL `licenseKind`; it is the exact
            // complement of `isOneTime` above. TIMED licences DO recur.
            plan: {
              OR: [
                { kind: { in: ['SUBSCRIPTION', 'USAGE'] } },
                { kind: 'LICENSE', licenseKind: 'TIMED' },
              ],
            },
            AND: [
              { OR: [boundSubject, { endUserId: input.endUser.id, planId: plan.id }] },
              {
                OR: [
                  { status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] } },
                  // A started-but-unfinished checkout on ANOTHER plan binds
                  // too, for as long as its session could still be paid.
                  // Excluding PENDING left the reachable version of this bug:
                  // start a PayPal checkout for `basic`, abandon the tab, start
                  // a Stripe one for `pro`, pay both. Two rows, two webhooks,
                  // two ACTIVE subscriptions on two processors.
                  //
                  // The tradeoff is the window, since nothing here can ask the
                  // processor whether a session it minted is still open. Bound
                  // to the session lifetime (see checkout-sessions.ts) an
                  // abandoned checkout stops pinning once nobody can complete
                  // it, at the cost of a buyer who leaves both tabs open for a
                  // day still being able to pay both. That is the narrower
                  // hole, and it runs on the same clock the coupon reservation
                  // already uses.
                  //
                  // Excluded: the row THIS checkout will write. Two open
                  // sessions on one plan are one row by design, and both stay
                  // completable on purpose, which is why the row remembers a
                  // list of them (see checkout-sessions.ts). Binding on it
                  // would refuse the ordinary "picked PayPal, went back, chose
                  // Stripe" without closing anything: the abandoned session
                  // survives either way.
                  //
                  // What DOES stop two completions is the second-completion
                  // guard in `applyCheckoutCompleted`. This comment used to
                  // say the applier was "the place to stop that", which read
                  // as a description of something that existed and was not:
                  // both completions landed, leaving two live provider-side
                  // subscriptions and one local row pointing at the last. The
                  // guard is there now. Do not widen this exclusion without
                  // checking it is still there.
                  {
                    status: 'PENDING',
                    updatedAt: { gt: new Date(Date.now() - CHECKOUT_SESSION_LIFETIME_MS) },
                    NOT: { endUserId: input.endUser.id, planId: plan.id },
                  },
                ],
              },
            ],
          },
          // A buyer already billed twice by this bug holds two entitling
          // subscriptions, and without this the binding provider was whatever
          // Postgres handed back first, which is a different answer on two
          // consecutive requests. Oldest wins, so the answer is stable and is
          // the relationship they have had longest.
          orderBy: { createdAt: 'asc' },
          select: { provider: true, plan: { select: { slug: true } } },
        });
    const boundProvider = bound?.provider ?? null;

    // An explicit request we cannot honour is refused; an absent one is pinned.
    //
    // The split matters. Asking for PayPal when you are already on Stripe is a
    // request with no correct outcome, and answering it by quietly charging you
    // on Stripe would be worse than saying no. But when nobody asked, the geo
    // router is free to pick a different provider than last time (a trip
    // abroad, a routing change), and that silent drift is the version of this
    // bug nobody would ever report. Pinning removes it.
    if (
      bound !== null &&
      boundProvider !== null &&
      input.provider !== undefined &&
      input.provider !== boundProvider
    ) {
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_PROVIDER_SWITCH_BLOCKED',
        message: `This subscriber already pays for "${bound.plan.slug}" through "${boundProvider}", and a subscription cannot be moved between payment providers. Checking out through "${input.provider}" would create a second subscription and bill them twice.`,
        fix: `Check out through "${boundProvider}", or cancel the existing subscription and let it terminate before starting a new one elsewhere. Read \`provider\` off the active subscription to know which one to offer.`,
      });
    }

    let providerName: BillingProviderName;
    try {
      providerName = await pickProvider({
        application: input.application,
        ...(input.country !== undefined && { country: input.country }),
        ...(boundProvider !== null
          ? { preferred: boundProvider as BillingProviderName }
          : input.provider !== undefined && { preferred: input.provider }),
      });
    } catch (e) {
      // The pin can name a provider the operator has since disabled, and the
      // router's own refusal is written for a caller who asked for one: it says
      // to omit `provider`, which is exactly what this caller did. Every
      // existing subscriber is locked out of every recurring purchase at this
      // point, and answering that sends them looking for a mistake they did
      // not make. Blocking is still right; only the wording changes, and it
      // names the two ways out.
      if (
        boundProvider !== null &&
        e instanceof RekeyError &&
        e.code === 'BILLING_PROVIDER_NOT_AVAILABLE'
      ) {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_BOUND_PROVIDER_UNAVAILABLE',
          message: `This subscriber pays through "${boundProvider}", which is no longer configured or enabled for this Application. A subscription cannot be moved between payment providers, so no checkout can be issued for them until that is resolved.`,
          fix: `Re-enable "${boundProvider}" in Panel → Application → Billing so existing subscribers can keep buying, or cancel their "${boundProvider}" subscription, let it terminate, and have them buy again through a provider that is still enabled.`,
        });
      }
      throw e;
    }

    // Resolved as soon as the provider is known and BEFORE any row is written:
    // whether the discount can actually be charged depends on the provider and
    // the flow, and a checkout that cannot honour the coupon must fail while
    // it still costs nothing. See checkout-discount.ts for what it refuses.
    const discount = couponContext
      ? resolveCheckoutDiscount({ plan, provider: providerName, isOneTime, coupon: couponContext })
      : null;

    // Same shape, same reason: refuse a trial this checkout cannot honour
    // while refusing is still free. Charging today for a plan the pricing page
    // advertised as a free trial is not a failure mode worth having.
    const trial = resolveCheckoutTrial({ plan, provider: providerName, isOneTime });

    // The row this checkout will upsert, read for its metadata and its status
    // further down (a live provider session must not be stranded, and an
    // entitled row keeps its dates through an upgrade) — and, immediately
    // below, for whose subscription it actually is.
    //
    // The provider-switch guard that used to sit here, keyed on this same
    // (application, endUser, plan) and compared AFTER the router had run, is
    // gone, but its KEY is not. It moved into the lookup above, as the second
    // arm of that `OR`, because the two keys protect different things and the
    // subject-scoped one alone let an org checkout rewrite a personal row's
    // provider. Read the comment there before narrowing either arm.
    //
    // It was also doing a job that had nothing to do with providers, and that
    // job is now the guard below rather than a side effect.
    const existing = await prisma.subscription.findUnique({
      where: {
        applicationId_endUserId_planId: {
          applicationId: input.application.id,
          endUserId: input.endUser.id,
          planId: plan.id,
        },
      },
    });

    // A LIVE subscription is not moved from one billing subject to another by
    // somebody opening a checkout.
    //
    // `beneficiaryOrgId` is not in the uniqueness constraint (#431), so a
    // personal subscription to `pro` and an org-billed one to `pro` for the
    // same buyer are the SAME row, and the upsert below writes
    // `beneficiaryOrgId` unconditionally. Alice owns Acme and Beta; Acme holds
    // `pro`; Alice opens a checkout for `pro` on behalf of Beta. That rewrote
    // Acme's row: still ACTIVE, still carrying Acme's `providerSubId`, but
    // billed to Beta. Acme's entitlement read null, Beta had it for free, the
    // processor kept charging Acme, and no payment was involved. Opening
    // checkout did it.
    //
    // This was covered by ACCIDENT until the provider binding above existed.
    // The guard that used to sit right here compared `existing.provider !==
    // providerName`, which also refused the rewrite — but only when the router
    // happened to disagree, and pinning now makes the two agree by
    // construction for every bound buyer. Fixing the reported axis removed the
    // cover on this one, so the refusal has to be stated rather than fall out.
    //
    // Only an ENTITLING row is protected. A PENDING one is a checkout nobody
    // completed: refusing over it would offer a remedy ("cancel it") that does
    // not exist, which is precisely the shape of refusal this change had to
    // remove once already for one-off purchases. The narrower hole it leaves —
    // the earlier subject pays, the later subject is entitled — is the same
    // one two open sessions on a single row already carry, and it closes for
    // good with #431.
    if (
      existing &&
      isEntitled(existing.status) &&
      existing.beneficiaryOrgId !== (input.beneficiaryOrgId ?? null)
    ) {
      // The held subject is described, not named: the caller was authorised for
      // the org they are BUYING for, and may not be a member of the one that
      // holds the row.
      const held =
        existing.beneficiaryOrgId === null ? 'their personal account' : 'a different organization';
      const wanted =
        input.beneficiaryOrgId === undefined ? 'their personal account' : 'this organization';
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_SUBSCRIPTION_SUBJECT_CONFLICT',
        message: `This buyer already holds a live subscription to "${plan.slug}" billed to ${held}, and a subscription to one plan is stored once per buyer. Checking out "${plan.slug}" for ${wanted} would move that subscription instead of starting a second one: the current holder would lose the entitlement while the payment provider kept charging for it.`,
        fix: `Cancel the existing "${plan.slug}" subscription and let it terminate before starting one for a different billing subject, or bill the two subjects on separate plans. Read the live subscription with GET /billing/subscription (pass \`organizationId\` for an org's) to see which subject holds it.`,
      });
    }

    // Take the coupon's slot BEFORE the provider mints the discount, and hold
    // it until the payment settles. `validate` above is advisory only: it
    // counts rows that the payment webhook writes, and that webhook is up to a
    // session-lifetime away — so the ceiling was being enforced against rows
    // that did not exist yet, and five checkouts on a `maxRedemptions: 1`
    // coupon charged five discounts. The reservation is what makes the limit
    // bound the DISCOUNTS rather than the bookkeeping. See coupons.service.ts.
    const reservation =
      couponContext !== null
        ? await couponsService.reserveForCheckout({
            couponId: couponContext.couponId,
            applicationId: input.application.id,
            endUserId: input.endUser.id,
            code: couponContext.code,
            discountAmount: couponContext.discountAmount,
          })
        : null;

    const provider = await getProviderForApplication(input.application, providerName);
    const checkoutInput = {
      application: { id: input.application.id, slug: input.application.slug },
      endUser: input.endUser,
      plan,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      // The discount goes to the PROCESSOR, not just onto our own rows. It
      // used to stop at `couponContext` below, so every coupon ever applied
      // charged the buyer full price while we recorded a discount and
      // redeemed the code.
      ...(discount !== null && { discount }),
      // Same seam, same lesson: the trial has to reach the PROCESSOR. It is
      // the provider that runs the clock and converts the trial into a
      // charge, so a trial that stops at our own rows charges the buyer today.
      ...(trial !== null && { trial }),
    };
    let session;
    try {
      session = isOneTime
        ? await provider.createOneTimeCheckout(checkoutInput)
        : await provider.createCheckoutSession(checkoutInput);
    } catch (e) {
      // No session means no discount was minted, so the slot goes straight
      // back rather than sitting out its 24-hour expiry — a reservation that
      // outlives the checkout it was for is a denial-of-discount against the
      // next buyer.
      if (reservation) await couponsService.releaseReservation(reservation.reservationId);
      // `audience: 'end-user'`. This is the public checkout surface: the caller
      // is the operator's CUSTOMER. Rethrowing raw gave them `500
      // INTERNAL_ERROR / "share this request id with support"` for somebody
      // else's misconfigured Stripe account — or, when the provider error
      // happened to carry a 4xx `.statusCode`, the operator's key fragment.
      throw providerError({
        provider: providerName,
        operation: 'checkout',
        audience: 'end-user',
        error: e,
      });
    }
    // The reservation becomes findable by (coupon, session) here, which is how
    // the webhook appliers settle it.
    if (reservation) {
      await couponsService.bindReservationToSession(reservation.reservationId, session.sessionId);
    }

    // Upsert by (applicationId, endUserId, planId): if the user already started
    // checkout for this same plan and bailed, reuse that PENDING row instead
    // of creating a parallel one.
    //
    // The metadata REMEMBERS the earlier sessions rather than overwriting them.
    // Overwriting stranded any still-live provider session — a Stripe Checkout
    // Session stays completable for ~24h — so a buyer who reopened checkout and
    // then went back and paid on the first tab matched no local row: 200 OK,
    // row still PENDING, no payment, no redemption, no trace of a real sale.
    // See checkout-sessions.ts.
    const subscriptionMetadata = buildCheckoutSessionMetadata({
      previous: existing?.metadata ?? null,
      sessionId: session.sessionId,
      isOneTime,
      provider: providerName,
      coupon: couponContext
        ? { couponId: couponContext.couponId, discountAmount: couponContext.discountAmount }
        : null,
    });
    const subscription = await prisma.subscription.upsert({
      where: {
        applicationId_endUserId_planId: {
          applicationId: input.application.id,
          endUserId: input.endUser.id,
          planId: plan.id,
        },
      },
      create: {
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        planId: plan.id,
        provider: providerName,
        status: 'PENDING',
        ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
        metadata: subscriptionMetadata as never,
      },
      update: {
        provider: providerName,
        // An ALREADY-PAYING row is not reset to PENDING. Opening a checkout is
        // not an event that removes entitlement, and this unconditionally made
        // it one: an ACTIVE subscriber who merely pressed Upgrade — or typed a
        // coupon into the form the account page now shows *existing*
        // subscribers — was downgraded on the spot. PENDING is not an
        // entitling status, so their portal showed them as unsubscribed and
        // every entitlement gate started refusing, without a single provider
        // event having happened. The provider's webhook is what moves a paying
        // subscription between states; this row is only a checkout record.
        //
        // Walking the row back to PENDING restarts its lifecycle, so the
        // previous cancellation's dates go with it. `(applicationId,
        // endUserId, planId)` is unique, so a resubscribe REUSES the cancelled
        // row, and a `cancelAt` left on it survives all the way through to the
        // live subscription — where it makes the account panel show
        // "Cancelling — ends <a past date>", hide the Cancel button, and turn
        // the cancel endpoint into a 200-OK no-op while the provider keeps
        // charging. An ENTITLED row keeps its dates: someone pressing Upgrade
        // mid-period has not withdrawn a cancellation they scheduled.
        ...(isEntitled(existing?.status)
          ? {}
          : { status: 'PENDING' as const, cancelAt: null, canceledAt: null }),
        ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
        metadata: subscriptionMetadata as never,
      },
    });

    // The redemption is RESERVED at this point, not settled: the coupon also
    // rides on `subscription.metadata.couponBySession`, and `webhooks/apply.ts`
    // confirms the reservation when the provider says the purchase completed.
    // Recording a settled redemption here would be abusable in the other
    // direction — apply a coupon, abandon checkout, and the per-user / global
    // limit is exhausted for legitimate buyers — which is why the reservation
    // expires on its own. See decisions.md 2026-05-19 and 2026-08-02.

    return {
      url: session.url,
      subscription,
      discountAmount: couponContext?.discountAmount ?? 0,
      provider: providerName,
    };
  },

  /**
   * The calling end-user's OWN payment history, newest first. Strictly
   * scoped by `(applicationId, endUserId)` — there is no way to read another
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
   * Cancel the calling end-user's current subscription (self-service portal
   * surface). Semantics:
   *
   *   - No ACTIVE/PAST_DUE/PENDING subscription → 404 SUBSCRIPTION_NOT_FOUND.
   *   - Default (`atPeriodEnd !== false`) on an ACTIVE sub with a known period
   *     end → the local row records `cancelAt = currentPeriodEnd` while staying
   *     ACTIVE, and any provider is told to stop at period end. The status
   *     flips to CANCELED when the provider's webhook announces the actual
   *     termination (subscription.deleted / .updated), or — for a row with no
   *     provider — when `expireIfDue` reads it after the date has passed.
   *   - Everything else (PENDING checkout that never activated, PAST_DUE, an
   *     explicit `atPeriodEnd: false`, or an ACTIVE sub with no known period
   *     end) → local status update to CANCELED now; the provider is still told
   *     to cancel when a provider-side subscription exists. Emits
   *     `subscription.canceled`.
   *
   * Which of the two a given subscription gets is `cancelEffect` in
   * `@rekey.dev/shared-types` — exported so a confirmation dialog can say it
   * before the call rather than guessing.
   *
   * Idempotent: cancelling an already-pending-cancel sub returns it unchanged.
   */
  async cancelCurrentSubscription(
    application: Application,
    endUser: EndUser,
    opts?: { atPeriodEnd?: boolean; organizationId?: string },
  ): Promise<Subscription> {
    const sub = await this.getCurrentSubscription(
      application,
      endUser,
      opts?.organizationId ? { organizationId: opts.organizationId } : undefined,
    );
    if (!sub) {
      throw new RekeyError({
        statusCode: 404,
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'You have no active subscription to cancel.',
        fix: 'Nothing to do — the user is not subscribed (or the subscription is already canceled).',
      });
    }

    // Terminal already. `getCurrentSubscription` can hand this a row that
    // `expireIfDue` just wrote EXPIRED, and `cancelEffect('EXPIRED')` is
    // 'immediate' — so without this the unconditional update rewrote a
    // terminal row to CANCELED and announced a cancellation that did not
    // happen. `cancelSubscriptionById` has always had this guard.
    if (sub.status === 'CANCELED' || sub.status === 'EXPIRED') return sub;


    const providerBacked = Boolean(sub.provider && sub.providerSubId);
    // Scheduling a cancellation for the end of the period does NOT require a
    // payment provider. It used to: `providerBacked` was part of this
    // predicate, so a subscription with no provider-side id fell through to
    // the immediate branch below and was CANCELED on the spot, with the free
    // ceiling written the same moment — no refund, mid-period, while the
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
      // End-user-facing cancel — same audience rule as checkout above.
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
      return prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAt: sub.currentPeriodEnd },
      });
    }

    // Cancel + its outbox row in one transaction: the customer's own cancel is
    // a state change a consumer has to hear about, so it must not be able to
    // commit without the announcement (see webhooks/apply.ts).
    const now = new Date();
    const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
      const row = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
      });
      return {
        updated: row,
        deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.canceled', row.id),
      };
    });
    kickDeliveries(deliveryIds);
    // Self-service cancel while PAST_DUE — close the dunning case (silently).
    const { dunningService } = await import('./dunning.service.js');
    await dunningService.closeForCanceledSubscription(updated.id);
    return updated;
  },

  /**
   * Operator-facing cancel of a SPECIFIC subscription by id (e.g. via the
   * operator MCP `cancel_subscription` tool). Mirrors `cancelCurrentSubscription`
   * but targets one row instead of the end-user's "current" one — so it's
   * unambiguous when a user has more than one subscription. The subscription
   * MUST belong to `application` (the caller resolves the application within
   * the operator's tenant first), so this can't reach across workspaces.
   */
  async cancelSubscriptionById(
    application: Application,
    subscriptionId: string,
    opts?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
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
    // NOT `cancelEffect` — this path deliberately still requires a
    // provider. It used to also require `providerBacked`, on the stated ground
    // that a provider-less row scheduled from here could sit ACTIVE and
    // entitling indefinitely if nobody ever loaded that user's portal, because
    // only `getCurrentSubscription` reaped it — and that "relaxing it needs the
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
    // mid-period, with no refund and entitlements gone the same second — while
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
      return prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAt: sub.currentPeriodEnd },
      });
    }

    // Same transactional cancel + announce as cancelCurrentSubscription.
    const now = new Date();
    const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
      const row = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
      });
      return {
        updated: row,
        deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.canceled', row.id),
      };
    });
    kickDeliveries(deliveryIds);
    const { dunningService } = await import('./dunning.service.js');
    await dunningService.closeForCanceledSubscription(updated.id);
    return updated;
  },

  /**
   * Cancel every still-billing provider subscription belonging to an end-user.
   * Used by the operator end-user delete / GDPR-erasure paths so the provider
   * (Stripe/PayPal/Razorpay) stops billing a row we are about to remove or
   * tombstone — otherwise the provider keeps charging a vanished user.
   *
   * Cancels immediately (`atPeriodEnd: false`) at the provider for each
   * ACTIVE/PAST_DUE subscription that has a provider-side id. Same
   * `BillingProvider.cancelSubscription` path the portal cancel + dunning
   * exhaustion use. BEST-EFFORT: a provider error must NOT block the
   * delete/erase — we log and continue, so the user is always removed. The
   * local row's status is intentionally left untouched (the delete/erase
   * caller removes or tombstones it next).
   *
   * Returns the count of subscriptions for which a provider cancel was
   * attempted (for the audit metadata).
   */
  async cancelActiveProviderSubscriptionsForEndUser(args: {
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
  },
};
