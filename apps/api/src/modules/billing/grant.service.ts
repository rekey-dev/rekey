/**
 * Granting a subscription that no payment provider is behind.
 *
 * ## Why this exists
 *
 * Until this module, exactly ONE code path in the product created a
 * `Subscription` row, `billingService.createCheckoutSession`, and it created
 * it `PENDING`. The only thing that ever moved a row to `ACTIVE` was a provider
 * webhook. So a deployment with no payment provider configured had no way to
 * record a sale at all: not through the API, not through the panel, not through
 * the operator MCP. The three subscription routes the API exposes are read,
 * read, and cancel.
 *
 * That is not a hypothetical gap. Before this module the only way to record a
 * sale a provider had not made was to write SQL against production. A row
 * written that way emits nothing, so the entitlement materialisation, the
 * outbound `subscription.activated` event, and everything downstream of it (a
 * buyer's workspace being created because they paid) never happened. The buyer
 * paid and then still had to let themselves in.
 *
 * The same gap is the self-hoster's: an offline bank transfer, a comped
 * account, an enterprise deal signed on paper, a migration off a previous
 * billing system. None of those have a provider event to wait for.
 *
 * ## This is not commerce
 *
 * This API is the open-source product and holds no knowledge of what Rekey
 * itself sells. Its prices, its plan→limits mapping and its provisioning live
 * in separate, privately deployed units that are not part of this codebase.
 * Nothing here knows about Rekey's plans, its workspace ceiling, or its
 * commercial stack. This takes an Application, a plan slug and an end-user,
 * exactly like the rest of this module. Rekey Cloud is simply the first caller,
 * through the same admin API every operator has.
 *
 * ## It goes through the same door a real activation does
 *
 * The point of a grant is NOT to write an `ACTIVE` row. It is to produce the
 * same consequences a provider activation produces, so that everything already
 * built on those consequences works:
 *
 *   - `entitlementsService.provision` materialises credits / licences onto the
 *     beneficiary, anchored per period exactly as a renewal is;
 *   - `enqueueSubscriptionEvent(tx, 'subscription.activated', …)` writes the
 *     outbox row **inside the same transaction** as the status flip, so the
 *     announcement cannot be lost by a crash between the two;
 *   - the delivery attempt is kicked after the commit and after provisioning,
 *     so a consumer sees the same ordering `applyCheckoutCompleted` gives it.
 *
 * Re-implementing any of those here would have produced a subscription that
 * looked active and behaved like nothing.
 *
 * ## A granted subscription is provider-less, deliberately
 *
 * `provider` and `providerSubId` are set to null on every grant, including when
 * the row previously carried a provider's ids (a lapsed Stripe subscription
 * being re-granted by hand). They are what the cancel paths consult to decide
 * who terminates the subscription when its date arrives, see
 * `cancelCurrentSubscription` and `expireIfDue` in `billing.service.ts`. A row
 * that claims a provider nobody is talking to is the worst of both: the local
 * expiry declines to act because it thinks a webhook is coming, and the
 * provider call fails because the subscription is not there. The previous ids
 * are kept under `metadata.grant` so the history is not lost.
 */

import type { Application, Prisma, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { plansService } from '../plans/plans.service.js';
import { entitlementsService } from './entitlements.service.js';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { isOneTimePlan } from './plan-kind.js';
import { claimGrantedTrial, trialSubjectKey } from './trial-eligibility.service.js';

/**
 * Statuses that already mean "this subscriber is entitled". A grant against one
 * of these is the idempotent no-op, see `grantSubscription`.
 *
 * Same pair `billingService.isEntitled` uses, and for the same reason: PAST_DUE
 * is inside the dunning window, not outside the sale.
 */
// TRIALING counts as already entitled, so a grant over a running trial is
// the same no-op a grant over an active subscription is.
const ENTITLED = new Set<Subscription['status']>(['ACTIVE', 'TRIALING', 'PAST_DUE']);

export interface GrantSubscriptionInput {
  application: Application;
  /** Plan slug within `application`. */
  planSlug: string;
  /** The subscriber. Exactly one of these is required; the route enforces it. */
  endUserId?: string;
  /** Case-insensitive; end-user emails are stored lowercased. */
  email?: string;
  /** Beneficiary org (owner+beneficiary, ORG_BILLING.md). Must belong to `application`. */
  organizationId?: string;
  /**
   * When the granted period ends. Omitted means open-ended: null, for a
   * recurring plan and a one-off alike (see `resolvePeriodEnd`). Must be in the
   * future, a subscription born already expired entitles nobody and would be
   * reaped by `expireIfDue` on the next read.
   *
   * Open-ended has a consequence at the other end of the lifecycle: with no
   * period, `cancelEffect` has nothing to schedule against, so cancelling that
   * subscription stops access immediately rather than at period end.
   */
  currentPeriodEnd?: Date;
  /** Free-text reason, kept on the row and in the audit trail. */
  note?: string;
  /**
   * Bind the row to an inbound-only provider instead of leaving it
   * provider-less.
   *
   * The module docblock argues for nulling the provider, and that argument
   * is about a provider NOBODY is talking to. An external billing system
   * (providers/modules/external) is somebody: it posted this activation and
   * will post the cancellation, so the row must carry its subscription id or
   * those later events find nothing. Only the granted-event applier passes
   * this; the admin route never does.
   */
  providerBinding?: { provider: string; providerSubId: string };
  /**
   * The trial the sender is running, when it is. `null` clears a stale one.
   *
   * A value in the FUTURE is a trial, and it goes through the trial ledger
   * (`claimGrantedTrial`) under the Application's `trialPolicy`, exactly as a
   * checkout does: honoured, the row is written TRIALING for the same reason
   * `applyCheckoutCompleted` does, so unpaid revenue is not reported as MRR;
   * refused, the subscription is still granted, ACTIVE and without the trial,
   * and the refusal is recorded under `metadata.refusedTrials`. Without this
   * an external sender or an import could hand one buyer a trial per event,
   * each written ACTIVE, and the one-per-buyer rule (#500) held only at
   * checkout.
   *
   * A value in the past is a trial that already ended: mirrored, never judged.
   */
  trialEndsAt?: Date | null;
  /**
   * What identifies THIS attempt in the ledger: the sender's event id, or the
   * import run. Required with a future `trialEndsAt`, alongside
   * `providerBinding`; together they key the redemption so a re-delivery of
   * the same event takes nothing new.
   */
  trialAttemptId?: string;
  /**
   * Extra writes that belong to the activation, run inside its transaction.
   *
   * Called only when THIS call activates the row, after the subscription write
   * and before `subscription.activated` is enqueued, so the event describes the
   * decorated row and the decoration commits or rolls back with the grant. The
   * import uses it for provenance metadata and `cancelAt`: written afterwards,
   * a crash between the two left an entitled row with no scheduled end, and a
   * retry could never add it because a repeated grant writes nothing.
   *
   * Returns the row as it now stands.
   */
  decorate?: (tx: Prisma.TransactionClient, subscription: Subscription) => Promise<Subscription>;
  /**
   * Record this activation as the actor's one free-tier claim on the plan.
   *
   * Set only by `activateFreePlan`, and only for a plan that materialises
   * CREDIT or LICENSE. The operator, import and external-provider paths never
   * set it: an operator handing out value is a deliberate act, not a tap.
   */
  freeTierClaim?: boolean;
}

export interface GrantSubscriptionResult {
  subscription: Subscription;
  /**
   * Whether THIS call performed the activation. False means the subscriber was
   * already entitled on this plan and nothing was written, provisioned or
   * announced, which is what makes a repeated grant safe.
   */
  activated: boolean;
  /**
   * Set when a future `trialEndsAt` was asked for and the ledger refused it.
   * The subscription was granted without the trial; the caller decides
   * whether that is worth telling somebody.
   */
  trialRefused?: { reason: 'already_used' | 'attempt_spent' };
}

/**
 * The period end for a grant.
 *
 * An explicit value always wins, an invoice is for whatever term was agreed,
 * and guessing a year deal is a month is the kind of error nobody notices until
 * renewal. Absent one the answer is null: a grant is open-ended, whether the
 * plan is recurring or a one-off. The comment on the return below says why
 * that changed.
 *
 * (This paragraph used to say a recurring plan got one interval from now via
 * `advanceBillingPeriod`, and kept saying it after the behaviour changed a few
 * lines below. Corrected rather than deleted, because a stale doc that
 * contradicts its own implementation is load-bearing misinformation: a reader
 * who trusts it concludes that cancelling a fresh grant schedules for period
 * end, when it stops access on the spot.)
 *
 * Null is not a shortcut here. It is what `cancelEffect` reads to decide
 * whether "cancel at the end of the period" is even a meaningful request, with
 * no period there is nothing to schedule, so the cancel is immediate, and what
 * `entitlementsService.provision` falls back to as the `'initial'` grant anchor
 * for a purchase that happens exactly once.
 */
function resolvePeriodEnd(
  plan: { kind: string; licenseKind: string | null; interval: string | null },
  explicit: Date | undefined,
  _now: Date,
): Date | null {
  if (explicit !== undefined) return explicit;
  if (isOneTimePlan(plan)) return null;
  // Open-ended unless the operator asks for a term.
  //
  // This used to default to one interval from now, which was harmless while
  // nothing read the column for a provider-less row and became a landmine the
  // moment the term fix made it load-bearing: "comp this account" quietly
  // meant "comp this account for one month", and nothing renews a grant,
  // `advanceBillingPeriod` is only ever called from here and from the provider
  // period-advance applier, which a grant never reaches.
  //
  // So the default now matches what the operator asked for. A grant with a
  // term is one somebody deliberately time-boxed, and that is exactly the case
  // the term fix exists to honour.
  return null;
}

/**
 * Merge the grant's provenance into the row's metadata, and **retire the
 * checkout-session pointers**.
 *
 * `checkoutSessionId` / `checkoutSessionIds` are how a provider webhook finds
 * the local row it belongs to (`checkoutSessionWhere` in checkout-sessions.ts),
 * and a hosted checkout session stays completable for about a day after it is
 * opened. Left in place, a buyer who abandoned checkout, was granted the plan
 * by hand, and then went back and completed the old tab would have
 * `applyCheckoutCompleted` stamp a `providerSubId` onto the granted row, which
 * is precisely the state the module docblock exists to prevent: the local
 * expiry stops acting because it believes a webhook is coming, and there is no
 * provider subscription to send one.
 *
 * They are moved under `grant.retiredCheckoutSessions` rather than dropped, so
 * a later "why did this buyer's session match nothing" is still answerable. The
 * coupon map (`couponBySession`) stays: it is read only when a session HAS
 * matched, so it can no longer be reached from here, and it is the record of
 * what a code was worth.
 */
function grantMetadata(
  previous: Prisma.JsonValue | null,
  entry: Record<string, unknown>,
  refusedTrial?: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base =
    typeof previous === 'object' && previous !== null && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {};
  const retired = [
    ...(Array.isArray(base.checkoutSessionIds) ? base.checkoutSessionIds : []),
    ...(typeof base.checkoutSessionId === 'string' ? [base.checkoutSessionId] : []),
  ].filter((id, i, all) => typeof id === 'string' && all.indexOf(id) === i);
  delete base.checkoutSessionId;
  delete base.checkoutSessionIds;
  // The last twenty, the same bound `refusedGrants` keeps in webhooks/apply.ts.
  const refusedTrials = refusedTrial
    ? [...(Array.isArray(base.refusedTrials) ? base.refusedTrials.slice(-19) : []), refusedTrial]
    : base.refusedTrials;
  return {
    ...base,
    ...(refusedTrials !== undefined && { refusedTrials }),
    grant: { ...entry, retiredCheckoutSessions: retired },
  } as Prisma.InputJsonValue;
}

export const subscriptionGrantsService = {
  /**
   * Self-serve activation of the Application's free tier, by the buyer.
   *
   * #392 decided that Rekey owns the subscription lifecycle and a provider is
   * asked to move money and nothing else, with two primitives: charge once now,
   * and start recurring on a date we choose. A free plan needs NEITHER, so it
   * needs no provider, which is #392's own step 2, and why this reuses
   * `grantSubscription` rather than reaching for a checkout.
   *
   * The gap it closes: a CREDIT or LICENSE entitlement only materialises from a
   * real subscription, `createCheckoutSession` always routes through a provider,
   * and `pickProvider` throws when none is configured. So an Application with no
   * payment provider could not put anybody on its own free tier, and a signed-up
   * user of a freemium product got nothing at all. `defaultPlanSlug` covers the
   * read-time half (FEATURE flags, included USAGE quota) and deliberately not
   * the stateful half.
   *
   * ## Why the guard is not `amount === 0`
   *
   * Price is a property of the checkout, not of what a plan hands over, and the
   * two are unrelated. A CREDIT plan at `amount: 0` with `creditsAmount: 10000`
   * mints ten thousand credits per activation; activation is idempotent per
   * subscriber and plan, but a grant for a NEW period after a cancellation
   * deliberately refills, so cancel-then-activate is an unbounded tap on exactly
   * the plan shape a free tier uses. A USAGE plan at `amount: 0` with a
   * `pricePerUnitCents` is free only in the headline.
   *
   * So the plan must be the one the operator NOMINATED as the free tier, and be
   * free on both axes. Nomination turns the guard from a property of the row
   * into a statement of intent, which is the thing that actually needs to be
   * true. `defaultPlanSlug` is already validated to name an active plan in this
   * Application when it is set.
   *
   * ## Once per person, when the plan hands over value
   *
   * Nomination bounds WHICH plan; it did not bound how many beneficiaries. The
   * subscription row is keyed (application, end-user, plan) and a reactivation
   * moves it to whatever beneficiary is named, while credits and licences are
   * keyed per beneficiary. So cancel, create an organization, activate for it,
   * and the same person collected the plan's credits (or a fresh pooled
   * licence) once per organization they could create, without limit.
   *
   * A plan that materialises CREDIT or LICENSE is therefore claimable once per
   * actor, across every beneficiary, recorded in `FreeTierClaim` in the same
   * transaction as the activation. The same rule a trial follows, for the same
   * reason (`assertTrialMaterialisesNothing`): value handed over before money
   * has no inverse. Reactivating for the beneficiary that holds the claim
   * stays allowed and issues nothing new, because the `'initial'` credit
   * anchor and the per-pool licence lookup already collide.
   *
   * FEATURE and USAGE resolve at read time and lapse with the subscription,
   * so a free plan carrying only those is left as it was: an admin of several
   * teams can still put each of them on it.
   */
  async activateFreePlan(input: {
    application: Application;
    endUserId: string;
    /** Beneficiary org, when the Application bills per organization. */
    organizationId?: string;
  }): Promise<GrantSubscriptionResult> {
    const billingConfig = BillingConfigSchema.parse(input.application.billingConfig);
    const slug = billingConfig.defaultPlanSlug;
    if (!slug) {
      throw new RekeyError({
        statusCode: 404,
        code: 'BILLING_NO_FREE_PLAN',
        message: 'This Application has no free tier, so there is nothing to activate.',
        fix: 'Nominate one by setting `defaultPlanSlug` with PATCH /api/v1/tenant/applications/:id/billing-config. The panel has no control for it yet. It must be an active plan costing nothing.',
      });
    }

    const plan = await plansService.getBySlug(input.application.id, slug);
    if (plan.amount !== 0 || plan.pricePerUnitCents !== null) {
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_FREE_PLAN_NOT_FREE',
        message: `The Application's default plan "${plan.slug}" is not free, so it cannot be self-activated.`,
        fix: 'A self-activated plan must cost nothing on both axes: `amount` 0 and no `pricePerUnitCents`. Send buyers of a priced plan through POST /api/v1/billing/checkout instead.',
      });
    }

    // Mirrors the conditions under which `entitlementsService.provision`
    // actually writes something, so the claim is required exactly when an
    // activation can hand over value.
    const materialises = (await entitlementsService.resolveForPlan(plan)).some(
      (e) => (e.kind === 'CREDIT' && (e.quantity ?? 0) > 0) || (e.kind === 'LICENSE' && !!e.licenseKind),
    );

    return this.grantSubscription({
      application: input.application,
      planSlug: plan.slug,
      endUserId: input.endUserId,
      ...(input.organizationId !== undefined && { organizationId: input.organizationId }),
      note: 'self-serve free tier',
      ...(materialises && { freeTierClaim: true }),
    });
  },

  /**
   * Activate a subscription for `planSlug` on behalf of a buyer who has paid
   * somewhere this deployment cannot see.
   *
   * ## Idempotency
   *
   * The `(applicationId, endUserId, planId)` unique key means there is at most
   * one row per subscriber per plan, and this reads it inside the transaction
   * that writes it. A subscriber already ACTIVE or PAST_DUE on the plan is
   * returned unchanged with `activated: false`: nothing is written, no
   * entitlement is materialised a second time, and no event is emitted. That
   * bound is the contract, granting twice must cost the same as granting once.
   *
   * Concurrently, too. Two simultaneous grants both read the pre-transaction
   * state, so the read alone settles nothing: the create path is separated by
   * the unique key (the loser catches P2002 and reports the winner's row) and
   * the re-grant path by a count-checked conditional update. Sequential-only
   * idempotency would still announce one sale twice to every consumer the
   * moment somebody double-clicked.
   *
   * It deliberately does NOT extend an existing period. "Grant" answers "this
   * person has bought this"; rolling a live subscription forward is a renewal,
   * a different question, and silently doing it under the same call would mean
   * a retried request could hand out a second period. To move a live grant to a
   * new term, cancel it and grant again.
   *
   * A row in any other state, PENDING (a checkout that never completed),
   * CANCELED or EXPIRED, IS activated. That is the one place this diverges
   * from `webhooks/apply.ts`, which refuses to reopen a terminal subscription.
   * The refusal there guards against a *replayed provider event* resurrecting
   * something the buyer ended; it is a defence against stale news. An operator
   * calling this endpoint is not stale news, and a customer who cancelled and
   * has now paid again must be servable without deleting rows by hand.
   *
   * ## Ordering
   *
   * Status flip and outbox row commit together; entitlements are materialised
   * after the commit; the delivery attempt is kicked last. Identical to
   * `applyCheckoutCompleted`, so a consumer of `subscription.activated` sees
   * the entitlements already in place when the event arrives.
   */
  async grantSubscription(input: GrantSubscriptionInput): Promise<GrantSubscriptionResult> {
    const applicationId = input.application.id;

    // Inactive plans are allowed on purpose. `createCheckoutSession` refuses
    // them because it is the PUBLIC self-serve surface and a withdrawn plan
    // must not be buyable. Grandfathering a customer onto a plan that is no
    // longer sold is a routine, deliberate operator act, and refusing it would
    // force the operator to re-open the plan to the whole catalogue to do it.
    const plan = await plansService.getBySlug(applicationId, input.planSlug);

    const endUser = await resolveEndUser(applicationId, input);

    const billingConfig = BillingConfigSchema.parse(input.application.billingConfig);
    if (billingConfig.billingSubject === 'org' && input.organizationId === undefined) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_ORGANIZATION_REQUIRED',
        message: 'This Application bills per organization, but no organization was named for the grant.',
        fix: "Pass `organizationId` of a team in this Application, or change the model in Panel → Application → Billing → Subject.",
      });
    }
    if (input.organizationId !== undefined) {
      const org = await prisma.organization.findFirst({
        where: { id: input.organizationId, applicationId },
        select: { id: true },
      });
      if (!org) {
        throw new RekeyError({
          statusCode: 404,
          code: 'ORGANIZATION_NOT_FOUND',
          message: `Organization "${input.organizationId}" not found in this application.`,
          fix: 'Use an organization id that belongs to this Application.',
        });
      }
    }

    const now = new Date();
    const currentPeriodEnd = resolvePeriodEnd(plan, input.currentPeriodEnd, now);
    if (currentPeriodEnd !== null && currentPeriodEnd <= now) {
      throw new RekeyError({
        statusCode: 400,
        code: 'SUBSCRIPTION_PERIOD_END_IN_PAST',
        message: 'A granted subscription cannot end in the past.',
        fix: 'Pass a `currentPeriodEnd` in the future, or omit it for an open-ended grant.',
      });
    }

    const key = { applicationId, endUserId: endUser.id, planId: plan.id };

    // A future trialEndsAt is a trial; anything else is a date to mirror.
    const trialEndsAt = input.trialEndsAt instanceof Date && input.trialEndsAt > now ? input.trialEndsAt : null;
    if (trialEndsAt !== null && (input.providerBinding === undefined || input.trialAttemptId === undefined)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'SUBSCRIPTION_TRIAL_UNATTRIBUTED',
        message: 'A granted trial must name the system running it and the attempt it belongs to.',
        fix: 'Pass `providerBinding` and `trialAttemptId` with a future `trialEndsAt`, or omit the trial. An operator grant carries no trial.',
      });
    }
    const attemptKey =
      trialEndsAt !== null
        ? `${input.providerBinding!.provider}:${input.providerBinding!.providerSubId}:${input.trialAttemptId!}`
        : null;

    const run = async (): Promise<{
      subscription: Subscription;
      activated: boolean;
      deliveryIds: string[];
      trialRefused?: GrantSubscriptionResult['trialRefused'];
    }> =>
      prisma.$transaction(async (tx) => {
        // Settled first, under a lock, so eight concurrent activations for
        // eight different organizations cannot all read "no claim yet". Ahead
        // of the entitled no-op on purpose: a request for a beneficiary that
        // does not hold the claim is refused with the reason, rather than
        // answered 200 with somebody else's subscription. The claim row itself
        // is written below, only once the subscription write has happened.
        const recordFreeTierClaim =
          input.freeTierClaim === true
            ? await settleFreeTierClaim(tx, {
                applicationId,
                endUserId: endUser.id,
                planId: plan.id,
                planSlug: plan.slug,
                organizationId: input.organizationId ?? null,
              })
            : null;

        const existing = await tx.subscription.findUnique({
          where: { applicationId_endUserId_planId: key },
        });
        if (existing && ENTITLED.has(existing.status)) {
          return { subscription: existing, activated: false, deliveryIds: [] as string[] };
        }

        // The ledger is consulted INSIDE the transaction that writes the row,
        // so a TRIALING subscription and the redemption that justifies it
        // commit together and roll back together, and the loser of the
        // P2002 race below leaves no orphan redemption behind.
        const claim =
          attemptKey !== null
            ? await claimGrantedTrial(tx, {
                applicationId,
                subjectKey: trialSubjectKey({
                  billingSubject: billingConfig.billingSubject,
                  endUserId: endUser.id,
                  beneficiaryOrgId: input.organizationId ?? null,
                }),
                endUserId: endUser.id,
                organizationId: input.organizationId ?? null,
                planId: plan.id,
                policy: billingConfig.trialPolicy,
                attemptKey,
                endsAt: trialEndsAt!,
                now,
              })
            : null;
        const onTrial = claim?.honoured === true;
        const refusedTrial =
          claim !== null && !claim.honoured
            ? {
                attemptKey,
                trialEndsAt: trialEndsAt!.toISOString(),
                reason: claim.reason,
                blockedByRedemptionId: claim.blockedBy.id,
                at: now.toISOString(),
              }
            : undefined;

        const data = {
          // TRIALING while somebody else's trial clock is running, ACTIVE
          // otherwise, the split `applyCheckoutCompleted` makes and for the
          // same reason: `computeMrrCents` sums `plan.amount` over ACTIVE.
          status: onTrial ? ('TRIALING' as const) : ('ACTIVE' as const),
          provider: input.providerBinding?.provider ?? null,
          providerSubId: input.providerBinding?.providerSubId ?? null,
          // A refused trial leaves no date behind: a row that says ACTIVE
          // and "trial ends next month" is the contradiction this exists to
          // prevent. A past date is history and is kept.
          ...(input.trialEndsAt !== undefined && {
            trialEndsAt: onTrial ? trialEndsAt : trialEndsAt !== null ? null : input.trialEndsAt,
          }),
          currentPeriodEnd,
          // A re-grant of a subscription that was scheduled to end, or had
          // ended, must not carry the old termination forward: `expireIfDue`
          // would read the stale `cancelAt`, find it in the past, and cancel
          // the grant on the very next portal load.
          cancelAt: null,
          canceledAt: null,
          beneficiaryOrgId: input.organizationId ?? null,
          metadata: grantMetadata(
            existing?.metadata ?? null,
            {
              grantedAt: now.toISOString(),
              note: input.note ?? null,
              // Kept so a hand-grant over a lapsed provider subscription does not
              // erase which provider it used to be, see the module docblock.
              previousProvider: existing?.provider ?? null,
              previousProviderSubId: existing?.providerSubId ?? null,
            },
            refusedTrial,
          ),
        };
        const trialRefused = refusedTrial ? { reason: refusedTrial.reason } : undefined;
        // Point the redemption at the row it justifies, the way `consumeTrial`
        // does for a checkout. Only reached when the write below succeeds;
        // a P2002 rolls the whole transaction back, redemption included.
        const bindTrial = async (subscriptionId: string): Promise<void> => {
          if (!onTrial) return;
          await tx.trialRedemption.update({
            where: { id: (claim as { redemptionId: string }).redemptionId },
            data: { subscriptionId },
          });
        };

        if (!existing) {
          const inserted = await tx.subscription.create({ data: { ...key, ...data } });
          const created = input.decorate ? await input.decorate(tx, inserted) : inserted;
          await bindTrial(created.id);
          await recordFreeTierClaim?.(created.id);
          return {
            subscription: created,
            activated: true,
            deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.activated', created.id),
            ...(trialRefused && { trialRefused }),
          };
        }

        // Conditional on the row STILL not being entitled, and count-checked.
        // Two concurrent grants both read the pre-transaction status, and a
        // plain `update` would let the loser proceed on the winner's row and
        // enqueue a second `subscription.activated` for one sale. Postgres
        // re-evaluates this predicate after the winner releases the row lock,
        // so the loser updates nothing and announces nothing, the same shape
        // `expireIfDue` uses in billing.service.ts.
        const { count } = await tx.subscription.updateMany({
          where: { id: existing.id, status: { notIn: [...ENTITLED] } },
          data,
        });
        const current = await tx.subscription.findUniqueOrThrow({ where: { id: existing.id } });
        const row = count !== 0 && input.decorate ? await input.decorate(tx, current) : current;
        if (count === 0) {
          // The winner's row stands; a redemption THIS transaction wrote
          // would justify nothing, so it must not survive the commit. One
          // found from an earlier attempt is history and stays.
          if (claim?.honoured === true && !claim.replayed) {
            await tx.trialRedemption.delete({ where: { id: claim.redemptionId } });
          }
          return { subscription: row, activated: false, deliveryIds: [] as string[] };
        }
        await bindTrial(row.id);
        await recordFreeTierClaim?.(row.id);
        return {
          subscription: row,
          activated: true,
          deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.activated', row.id),
          ...(trialRefused && { trialRefused }),
        };
      });

    let outcome;
    try {
      outcome = await run();
    } catch (e) {
      // P2002 on (applicationId, endUserId, planId): two grants for the same
      // subscriber raced past the `findUnique` above and both tried to create
      // the row. The unique key is what makes only one of them real; the loser
      // reports the winner's result rather than a 500, because from the
      // caller's side the two are one idempotent request.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      // Only the (applicationId, endUserId, planId) key is the benign race.
      // With a provider binding the same code can name
      // (applicationId, providerSubId): the sender's id is already on another
      // row, which is a conflict the caller must see, not a win to report.
      const target = (e as { meta?: { target?: unknown } }).meta?.target;
      if (Array.isArray(target) && target.some((t) => String(t).includes('provider_sub'))) throw e;
      const won = await prisma.subscription.findUniqueOrThrow({
        where: { applicationId_endUserId_planId: key },
      });
      return { subscription: won, activated: false };
    }
    const { subscription, activated, deliveryIds, trialRefused } = outcome;

    if (!activated) return { subscription, activated: false };

    // `firstPeriod` is deliberately not passed. The flag pins the grant to the
    // `'initial'` anchor, which exists to make a checkout and its first
    // provider invoice collide instead of double-granting. There is no invoice
    // here, and the anchor that is actually right is the period itself: a
    // repeated grant for the same period collides (nothing re-granted), and a
    // grant for a NEW period after a cancellation refills credits and rolls a
    // timed licence forward exactly once. See entitlements.service.ts.
    await entitlementsService.provision({ subscription });
    kickDeliveries(deliveryIds);
    return { subscription, activated: true, ...(trialRefused && { trialRefused }) };
  },
};

/**
 * Decide a free-tier claim, and return what records it once the activation is
 * written. Throws when the actor already claimed the plan for somebody else.
 *
 * The advisory lock is keyed on the claim's own identity, so concurrent
 * activations by one actor serialise here and the second reads the first's
 * committed row. The unique key on `free_tier_claims` is the backstop: were
 * the lock ever lost, the second insert fails P2002 and the whole activation
 * rolls back with it.
 *
 * Same beneficiary returns a recorder that writes nothing: the claim already
 * exists, and a reactivation for it issues nothing new because the credit
 * anchor (`'initial'` for an open-ended grant) and the per-pool licence lookup
 * in `entitlementsService.provision` both collide.
 */
async function settleFreeTierClaim(
  tx: Prisma.TransactionClient,
  args: {
    applicationId: string;
    endUserId: string;
    planId: string;
    planSlug: string;
    organizationId: string | null;
  },
): Promise<(subscriptionId: string) => Promise<void>> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rekey:free-tier:${args.applicationId}:${args.endUserId}:${args.planId}`}, 0))`;
  const prior = await tx.freeTierClaim.findUnique({
    where: {
      applicationId_endUserId_planId: {
        applicationId: args.applicationId,
        endUserId: args.endUserId,
        planId: args.planId,
      },
    },
    select: { organizationId: true },
  });
  if (prior) {
    if (prior.organizationId !== args.organizationId) {
      const holder = prior.organizationId ? 'an organization' : 'your personal account';
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_FREE_TIER_ALREADY_CLAIMED',
        message:
          `The free plan "${args.planSlug}" grants credits or a licence, and you already claimed it ` +
          `for ${holder}. It can be claimed once per person.`,
        fix:
          'An operator can grant the plan to this beneficiary, or the buyer can purchase a plan for ' +
          'it through POST /api/v1/billing/checkout. Reactivating it for the beneficiary that ' +
          'already holds the claim is allowed.',
      });
    }
    return async () => {};
  }
  return async (subscriptionId) => {
    await tx.freeTierClaim.create({
      data: {
        applicationId: args.applicationId,
        endUserId: args.endUserId,
        planId: args.planId,
        organizationId: args.organizationId,
        subscriptionId,
      },
    });
  };
}

/** Resolve the subscriber by id or email, always scoped to the Application. */
async function resolveEndUser(
  applicationId: string,
  input: Pick<GrantSubscriptionInput, 'endUserId' | 'email'>,
): Promise<{ id: string }> {
  const endUser = input.endUserId
    ? await prisma.endUser.findFirst({
        where: { id: input.endUserId, applicationId },
        select: { id: true, erasedAt: true },
      })
    : await prisma.endUser.findUnique({
        // Stored lowercased at sign-up; an operator typing the address off an
        // invoice will not match the casing.
        where: { applicationId_email: { applicationId, email: (input.email ?? '').toLowerCase() } },
        select: { id: true, erasedAt: true },
      });
  if (!endUser) {
    throw new RekeyError({
      statusCode: 404,
      code: 'END_USER_NOT_FOUND',
      message: 'No end-user in this application matches that id or email.',
      fix:
        'The buyer must have an account in this Application before a subscription can be granted ' +
        'to them. Have them sign up, or find them with GET /api/v1/admin/metrics/end-users?q=.',
    });
  }
  // Nothing can be granted to a tombstone.
  //
  // `subscriber.service.ts` has refused this since the external provider
  // landed; this path did not, and that asymmetry is a live hazard now that an
  // operator can reach granting from the same end-user page that carries the
  // Erase button. Erasure's contract is that financial rows are RETAINED and
  // PII-scrubbed; a grant afterwards writes a fresh, un-scrubbed one, with the
  // operator's free-text note, typically a name or an invoice reference, on a
  // subject the workspace has legally committed to scrubbing, and announces
  // `subscription.activated` for an id that just announced `user.erased`.
  //
  // Guarded here rather than at either route so both the operator and the
  // super-admin surface inherit it.
  if (endUser.erasedAt !== null) {
    throw new RekeyError({
      statusCode: 410,
      code: 'END_USER_ERASED',
      message: 'That end-user was erased; nothing can be granted to the tombstone.',
      fix: 'If this person is a customer again, they must create a new account, an erasure cannot be undone. Remove them from the billing system that produced this grant as well.',
    });
  }
  return { id: endUser.id };
}
