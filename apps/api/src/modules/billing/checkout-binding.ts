/**
 * The subscription that already binds a buyer to a payment provider, read the
 * same way by checkout and by everything that predicts what checkout will do.
 */

import { ENTITLING_SUBSCRIPTION_STATUSES } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { checkoutStillPayable, pendingCheckoutPrefilter } from './checkout-sessions.js';

/** What checkout reads off the row that binds a buyer. */
export interface BindingSubscription {
  id: string;
  provider: string | null;
  status: string;
  currency: string | null;
  unitAmount: number | null;
  providerSubId: string | null;
  plan: { slug: string };
  metadata: unknown;
  updatedAt: Date;
}

/** A row that could bind this buyer, before the plan being bought is known. */
export interface BindingCandidate extends BindingSubscription {
  endUserId: string;
  planId: string;
  beneficiaryOrgId: string | null;
}

/** Whose subscriptions bind: the buyer's own, or those of the organization the checkout bills. */
export interface BindingSubject {
  applicationId: string;
  endUserId: string;
  /** The organization the checkout bills, when it bills one. */
  beneficiaryOrgId?: string | undefined;
  now?: Date;
}

/**
 * Find the row that binds this buyer, or null. Call it for a recurring plan
 * only: a one-off purchase neither binds nor is bound.
 *
 * @example
 * const bound = await findBindingSubscription({ applicationId, endUserId, planId: plan.id });
 * bound?.provider; // 'stripe' when they already pay through Stripe
 */
export async function findBindingSubscription(
  args: BindingSubject & {
    /** The plan being bought: an unfinished checkout of this same plan does not bind. */
    planId: string;
  },
): Promise<BindingSubscription | null> {
  return bindingAmong(await loadBindingCandidates(args), args);
}

/**
 * The row among `candidates` that binds a checkout of `planId`, or null.
 *
 * Split from the read so a caller answering for many plans reads once.
 *
 * @example
 * const candidates = await loadBindingCandidates({ applicationId, endUserId });
 * const bound = bindingAmong(candidates, { endUserId, planId: plan.id });
 */
export function bindingAmong(
  candidates: readonly BindingCandidate[],
  args: Pick<BindingSubject, 'endUserId' | 'beneficiaryOrgId' | 'now'> & { planId: string },
): BindingSubscription | null {
  const checkedAt = args.now ?? new Date();
  const ofSubject = (row: BindingCandidate): boolean =>
    args.beneficiaryOrgId !== undefined
      ? row.beneficiaryOrgId === args.beneficiaryOrgId
      : row.endUserId === args.endUserId && row.beneficiaryOrgId === null;
  // The row this checkout will write, see `loadBindingCandidates`.
  const ownRow = (row: BindingCandidate): boolean => row.endUserId === args.endUserId && row.planId === args.planId;
  return (
    candidates.find((row) => {
      if (!ofSubject(row) && !ownRow(row)) return false;
      if (row.status !== 'PENDING') return true;
      return !ownRow(row) && checkoutStillPayable(row, checkedAt);
    }) ?? null
  );
}

/**
 * Every row that could bind this buyer, whatever plan they go on to buy:
 * `bindingAmong` narrows it to one plan.
 *
 * @example
 * const candidates = await loadBindingCandidates({ applicationId, endUserId, beneficiaryOrgId: org.id });
 */
export async function loadBindingCandidates(args: BindingSubject): Promise<BindingCandidate[]> {
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
  //     planId)` by the upsert in `createCheckoutSession`, which does NOT include
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
    args.beneficiaryOrgId !== undefined
      ? { beneficiaryOrgId: args.beneficiaryOrgId }
      : { endUserId: args.endUserId, beneficiaryOrgId: null };
  const bindingCheckedAt = args.now ?? new Date();
  return prisma.subscription.findMany({
    where: {
      applicationId: args.applicationId,
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
        // The second arm is narrowed to the plan being bought in `bindingAmong`.
        { OR: [boundSubject, { endUserId: args.endUserId }] },
        {
          OR: [
            {
              status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] },
              // A row whose scheduled cancellation has already come due
              // does not bind. `expireIfDue` is lazy by design: it flips
              // such a row to CANCELED the first time anybody READS it,
              // and this query is not a read that runs it. So without
              // this clause the same database state answered checkout
              // two different ways depending on whether an unrelated
              // `GET /billing/subscription` happened to run first, which
              // is the kind of thing that makes a support report
              // impossible to reproduce (#439).
              //
              // Filtered here rather than by sweeping first, because the
              // sweep is a write and nothing on the checkout path should
              // take one to answer a question.
              OR: [{ cancelAt: null }, { cancelAt: { gt: new Date() } }],
            },
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
            //
            // The window itself is decided in `bindingAmong`, because its
            // clock lives in `metadata` (see checkoutBindsUntil). The
            // prefilter only keeps long-dead rows out of the result.
            // `bindingAmong` applies the exclusion, which names the plan.
            { status: 'PENDING', ...pendingCheckoutPrefilter(bindingCheckedAt) },
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
    // `status` is read only to word checkout's refusals. A PENDING binder
    // is somebody who has never paid, and telling them to cancel a
    // subscription is telling them to cancel nothing.
    select: {
      id: true,
      endUserId: true,
      planId: true,
      beneficiaryOrgId: true,
      provider: true,
      status: true,
      currency: true,
      unitAmount: true,
      // Read with `status` because PENDING alone does not mean "unfinished
      // checkout". Stripe's `paused`, and every status this codebase does
      // not recognise, also map to PENDING (providers/modules/stripe:75,
      // and the `default` arm below it), and those rows KEEP their
      // `providerSubId`. Such a row is a real provider-side subscription,
      // so calling it an unfinished checkout, saying nothing was
      // recorded, or saying it can always be cancelled would all be
      // false. The pair is the honest test.
      providerSubId: true,
      plan: { select: { slug: true } },
      metadata: true,
      updatedAt: true,
    },
  });
}
