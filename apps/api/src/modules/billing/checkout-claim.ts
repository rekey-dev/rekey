/**
 * The one step of opening a checkout that is serialised per buyer: under an
 * advisory lock it settles the trial this buyer may have, refuses when another
 * checkout of theirs bound a different provider in the meantime, and claims
 * the PENDING subscription row.
 */

import { ENTITLING_SUBSCRIPTION_STATUSES, type BillingConfig } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { CHECKOUT_SESSION_LIFETIME_MS, checkoutStillPayable, pendingCheckoutPrefilter } from './checkout-sessions.js';
import type { BillingProviderName } from './credentials.service.js';
import { priceLabel } from './price-label.js';
import type { PricedPlan } from './providers/types.js';
import { checkTrialEligibility, reserveTrial, trialAlreadyUsed, trialSubjectKey } from './trial-eligibility.service.js';

export interface CheckoutClaim {
  /** The trial this checkout carries, which is not always the plan's. */
  effectiveTrial: { days: number } | null;
  trialReservationId: string | null;
  /** Whether the PENDING row is this checkout's own, to delete if the provider then refuses. */
  claimCreatedRow: boolean;
}

/**
 * @example
 * const { effectiveTrial, trialReservationId, claimCreatedRow } = await claimCheckout({
 *   applicationId, endUserId, beneficiaryOrgId: undefined, allowWithoutTrial: false,
 *   plan, priced, providerName: 'stripe', trial: { days: 14 }, billingConfig,
 * });
 */
export async function claimCheckout(args: {
  applicationId: string;
  endUserId: string;
  beneficiaryOrgId: string | undefined;
  /** Carry on without a trial when this buyer has used theirs, instead of refusing. */
  allowWithoutTrial: boolean | undefined;
  plan: { id: string; slug: string };
  priced: PricedPlan;
  providerName: BillingProviderName;
  /** The trial the plan and provider allow, before this buyer's eligibility is known. */
  trial: { days: number } | null;
  billingConfig: Pick<BillingConfig, 'billingSubject' | 'trialPolicy'>;
}): Promise<CheckoutClaim> {
  const { plan, priced, providerName, trial, billingConfig } = args;
  // The EFFECTIVE trial, which is not the plan's trial. Whether this buyer
  // may have one is decided under the trial lock below (#477), so the input
  // handed to the provider is assembled after that transaction commits
  // rather than here. Building it here and mutating it later would mean the
  // object crossing the lock boundary was not the object that was decided.
  let effectiveTrial: { days: number } | null = trial;
  let trialReservationId: string | null = null;
  // ---- Serialise the binding decision (#437) -------------------------
  //
  // Everything above is read-then-act with nothing holding the two together,
  // so two overlapping checkouts by the same buyer BOTH read a state in
  // which nothing binds them and both proceed. Neither guard above is wrong;
  // each request is right about what it saw. Measured: two concurrent
  // checkouts on different plans naming different processors both returned
  // 200 and left the buyer billable by Stripe AND PayPal.
  //
  // Three things this is NOT, because each looks like the obvious fix:
  //
  //   * `SELECT ... FOR UPDATE` on the subscription row. On a buyer's first
  //     checkout there is no row to lock, and that is exactly the racing
  //     case. You cannot lock a row that does not exist yet.
  //   * The uniqueness constraint. `(applicationId, endUserId, planId)`
  //     already collapses two racing checkouts on the SAME plan into one row
  //    , that case is genuinely safe today. The one that bills twice is two
  //     DIFFERENT plans, where the keys differ and nothing collides. An
  //     index cannot serialise a decision, only reject a duplicate.
  //   * Wrapping the whole method in a transaction. The provider network
  //     call sits between the decision and the write, so that would hold a
  //     Postgres connection open across a call to Stripe for up to its 10s
  //     budget. Under the double-click storm this exists to survive, that
  //     trades double billing for pool exhaustion on the checkout path.
  //
  // So: a transaction-scoped ADVISORY lock keyed on (application, end-user),
  // which works whether or not a row exists, taken for a short DB-only
  // window that re-reads the binding and CLAIMS the row. The provider call
  // stays outside it.
  //
  // The claim is not decoration, and the reason is worth stating precisely.
  // The lock alone serialises the two requests, but the winner does not
  // write its real row until AFTER the lock has been released, the provider
  // call sits in between, so a loser that acquires the lock in that window
  // still finds nothing and proceeds. Measured with the claim removed and
  // the lock kept: two concurrent checkouts happened to be safe, ten were
  // not, and still split across both processors. Claiming the row before the
  // lock lifts is what closes that window.
  //
  // The check above and this one are not redundant. The first produces the
  // worded, buyer-facing refusals; this one is the authoritative gate, and
  // it only ever fires on a genuine race.
  //
  // Skipped entirely for a one-off purchase. A credit pack or a perpetual
  // licence creates no billing relationship, so there is no binding to race
  // over and nothing to claim, and running it anyway REFUSED a legitimate
  // one-off from a buyer who happened to hold a recurring subscription
  // elsewhere, because this re-check filters the candidate ROWS by kind but
  // cannot see the kind of the purchase being made.
  // Placed as LATE as possible while still preceding the provider call.
  // It sat right after the provider was picked, which is before the discount
  // and trial refusals, so a checkout refused for an unsupported coupon
  // left a claimed PENDING row behind, and that row binds the buyer. The
  // window this has to close is the provider round-trip; everything before
  // it is local and fast.
  const bindingLockKey = `rekey:checkout:${args.applicationId}:${args.endUserId}`;
  let claimCreatedRow = false;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${bindingLockKey}, 0))`;

    // ---- One trial per buyer (#477) ---------------------------------
    //
    // A SECOND advisory lock, always taken after the binding one so the pair
    // cannot deadlock. Re-keying the binding lock to the billing subject
    // instead, the obvious-looking simplification, would break #437 on an
    // org-billed application: everything the binding lock protects filters on
    // `endUserId`, so one buyer opening concurrent checkouts for two
    // different orgs would take two different locks and both would claim.
    //
    // Reachable only when the plan actually offers a trial this provider can
    // express, so a plan without one reads nothing new and can refuse nothing
    // new. `trial !== null` also implies `!isOneTime`: resolveCheckoutTrial
    // refuses a trial on a one-off purchase before this point.
    if (trial !== null) {
      const subjectKey = trialSubjectKey({
        billingSubject: billingConfig.billingSubject,
        endUserId: args.endUserId,
        beneficiaryOrgId: args.beneficiaryOrgId ?? null,
      });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rekey:trial:${args.applicationId}:${subjectKey}`}, 0))`;

      const eligibility = await checkTrialEligibility(tx, {
        applicationId: args.applicationId,
        subjectKey,
        planId: plan.id,
        policy: billingConfig.trialPolicy,
      });

      if (!eligibility.eligible) {
        // Refuse rather than silently charge. The page said free; a provider
        // that charges today is a dispute, not a rendering bug, and that the
        // buyer is a repeat trialist does not make the surprise acceptable.
        // The way through is an acknowledgement from the call site that
        // rendered the price.
        if (!args.allowWithoutTrial) {
          const blockedPlan = eligibility.blockedBy
            ? await tx.plan.findUnique({
                where: { id: eligibility.blockedBy.planId },
                select: { slug: true },
              })
            : null;
          throw trialAlreadyUsed({
            planSlug: plan.slug,
            ...(blockedPlan?.slug !== undefined && { blockedByPlanSlug: blockedPlan.slug }),
            ...(priceLabel(priced) !== null && { priceLabel: priceLabel(priced)! }),
          });
        }
        // Acknowledged: buy at full price. No reservation, because no slot is
        // being taken, this buyer already spent theirs.
        effectiveTrial = null;
      } else {
        // Take the slot BEFORE the provider call, exactly as the coupon slot
        // is taken: the provider-side trial goes live the instant the session
        // is created and stays payable for that session's whole life.
        const reserved = await reserveTrial(tx, {
          applicationId: args.applicationId,
          subjectKey,
          endUserId: args.endUserId,
          organizationId: args.beneficiaryOrgId ?? null,
          planId: plan.id,
          trialDays: trial.days,
          expiresAt: new Date(Date.now() + CHECKOUT_SESSION_LIFETIME_MS),
        });
        trialReservationId = reserved.id;
      }
    }

    const existingBeforeClaim = await tx.subscription.findUnique({
      where: {
        applicationId_endUserId_planId: {
          applicationId: args.applicationId,
          endUserId: args.endUserId,
          planId: plan.id,
        },
      },
      select: { id: true },
    });

    const racedCheckedAt = new Date();
    const racedCandidates = await tx.subscription.findMany({
      where: {
        applicationId: args.applicationId,
        endUserId: args.endUserId,
        provider: { not: null },
        NOT: { provider: providerName },
        // Same recurring-kinds filter as the binder read above: a one-off
        // credit pack must not pin a buyer to whoever sold it.
        plan: {
          OR: [
            { kind: { in: ['SUBSCRIPTION', 'USAGE'] } },
            { kind: 'LICENSE', licenseKind: 'TIMED' },
          ],
        },
        OR: [
          {
            status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] },
            // A row whose scheduled cancellation has already come due does
            // not bind, exactly as in the binder read above (#439).
            // `expireIfDue` is lazy and this query does not run it, so
            // without this clause the same state answers checkout
            // differently depending on whether an unrelated read happened
            // first, and here it answered by refusing a legitimate sale.
            OR: [{ cancelAt: null }, { cancelAt: { gt: new Date() } }],
          },
          {
            // A live checkout somebody else opened. Same session clock the
            // binder read uses, and the same exclusion of the row THIS
            // checkout writes, otherwise a buyer retrying their own
            // checkout would be refused by their own previous attempt.
            // The window is decided in code below, as in the binder read.
            status: 'PENDING',
            ...pendingCheckoutPrefilter(racedCheckedAt),
            NOT: { planId: plan.id },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, status: true, metadata: true, updatedAt: true },
    });
    const raced = racedCandidates.find(
      (row) => row.status !== 'PENDING' || checkoutStillPayable(row, racedCheckedAt),
    );

    if (raced?.provider) {
      // Retryable on purpose, and worded that way. The buyer double-clicked;
      // the other click won and bound them. Retrying now reads the binding
      // above and routes them to the SAME processor, which is the outcome
      // they wanted, so this must not read like a dead end.
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_CHECKOUT_RACE',
        message: `Another checkout for this account completed first and is paying through "${raced.provider}".`,
        fix: 'Try again. The retry will send you to the same payment provider as the checkout that won.',
      });
    }

    // Claim the row so a checkout racing this one SEES a binding. `update`
    // is empty deliberately: an existing row is somebody's real subscription
    // and the upsert further down owns every field on it. All this needs is
    // for the row to exist, holding this provider, before the lock lifts.
    await tx.subscription.upsert({
      where: {
        applicationId_endUserId_planId: {
          applicationId: args.applicationId,
          endUserId: args.endUserId,
          planId: plan.id,
        },
      },
      create: {
        applicationId: args.applicationId,
        endUserId: args.endUserId,
        planId: plan.id,
        provider: providerName,
        status: 'PENDING',
        ...(args.beneficiaryOrgId !== undefined && { beneficiaryOrgId: args.beneficiaryOrgId }),
      },
      update: {},
    });
    // Whether the row is OURS. A checkout that fails after this point must
    // not leave a PENDING row claiming a provider behind: that row binds the
    // buyer, so the next legitimate checkout they start somewhere else is
    // refused by the wreckage of one that never happened.
    claimCreatedRow = existingBeforeClaim === null;
  });
  return { effectiveTrial, trialReservationId, claimCreatedRow };
}
