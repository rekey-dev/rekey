/**
 * Trial eligibility, how many free trials one billing subject may take.
 *
 * `resolveCheckoutTrial` answers "does this PLAN offer a trial this provider can
 * express". It is a pure function of the plan and it has no idea who is asking.
 * This module answers the other half: "may THIS BUYER have one". Without it a
 * buyer could trial, cancel on the last day, and trial again without limit
 * (#477), and for a plan carrying entitlements each loop handed out a full
 * period of credits.
 *
 * Modelled on `coupons.service.ts`, which solved this exact shape first: a row
 * per attempt, a reservation taken before the provider call, and eligibility
 * decided by COUNTING slot holders rather than by a unique key. See the
 * `TrialRedemption` docblock in schema.prisma for why counting, not uniqueness.
 *
 * One deliberate divergence from coupons. A coupon reservation holds its slot
 * only while `expiresAt > now`; a trial redemption also holds it when
 * `expiresAt IS NULL`. That is the fail-CLOSED direction, and it is what a
 * confirmation that could not be recorded sets. Ageing such a row out would
 * fail OPEN for an anti-abuse control and hand the buyer another trial.
 */

import type { Plan, Prisma, TrialRedemption } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { isOneTimePlan } from './plan-kind.js';

export type TrialPolicy = 'once_per_application' | 'once_per_plan' | 'unlimited';

/** Either the module-level client or a `$transaction` one. */
type Db = Pick<typeof prisma, 'trialRedemption'> | Prisma.TransactionClient;

/**
 * The billing subject a trial is counted against.
 *
 * An org-billed Application keys on the beneficiary organization. Keying it on
 * the individual would hand a five-person team five trials, and would refuse a
 * colleague who takes the account over.
 */
export function trialSubjectKey(args: {
  billingSubject: 'user' | 'org';
  endUserId: string;
  beneficiaryOrgId?: string | null;
}): string {
  if (args.billingSubject === 'org' && args.beneficiaryOrgId) {
    return `org:${args.beneficiaryOrgId}`;
  }
  return `user:${args.endUserId}`;
}

/**
 * Rows that occupy a trial slot.
 *
 *   CONSUMED, the provider actually started a trial.
 *   RESERVED, not yet expired, a checkout is in flight for it.
 *   RESERVED with a NULL expiry, a confirmation that could not be recorded.
 *     Fail-closed: the trial probably DID start and we failed to write it
 *     down, so the slot is held until an operator resolves it.
 *
 * `forPlanId` excludes the subject's own live reservation FOR THAT PLAN, and is
 * the whole point of the parameter. Every row here is the subject's own
 * (`subjectKey` is the subject), so their in-flight checkout on the plan they
 * are buying is not a reason to refuse them, `reserveTrial` takes it over.
 *
 * Without it, a buyer who opened a trial checkout, bailed at the provider and
 * came back was refused with `BILLING_TRIAL_ALREADY_USED`, naming a trial they
 * never received, for the 24 hours until the reservation expired. The take-over
 * never ran, because it only runs down the ELIGIBLE branch.
 *
 * Scoped to the plan rather than dropped altogether. A live reservation still
 * blocks a DIFFERENT plan under `once_per_application`: otherwise a buyer could
 * open a checkout on every plan in the catalogue, pay them all, and collect a
 * free trial on each, the take-over releases the older rows, but `consumeTrial`
 * matches RELEASED too, so every paid session would still record a trial.
 *
 * Mirrors `coupons.service.ts`, whose `slotHolderWhere` takes the same kind of
 * exclusion for the same reason.
 *
 * RELEASED never holds a slot on its own: the attempt died, or it was taken over.
 */
export function slotHolderWhere(
  applicationId: string,
  subjectKey: string,
  now: Date,
  forPlanId?: string,
): Prisma.TrialRedemptionWhereInput {
  return {
    applicationId,
    subjectKey,
    OR: [
      { status: 'CONSUMED' },
      { status: 'RESERVED', expiresAt: null },
      {
        status: 'RESERVED',
        expiresAt: { gt: now },
        ...(forPlanId !== undefined && { planId: { not: forPlanId } }),
      },
    ],
  };
}

export interface TrialEligibility {
  eligible: boolean;
  policy: TrialPolicy;
  /** The redemption that blocks this buyer, when one does. */
  blockedBy?: Pick<TrialRedemption, 'id' | 'planId' | 'status' | 'startedAt' | 'endsAt'>;
}

/**
 * May this subject take one more trial?
 *
 * `unlimited` never refuses and never reads. `once_per_plan` counts within the
 * plan; `once_per_application` counts across the Application, which is the rule
 * the limit exists for, trialling `basic` and then `pro` is two free months of
 * the product, and per-plan would allow it.
 */
export async function checkTrialEligibility(
  db: Db,
  args: {
    applicationId: string;
    subjectKey: string;
    planId: string;
    policy: TrialPolicy;
    now?: Date;
  },
): Promise<TrialEligibility> {
  // `unlimited` never refuses and reads nothing. It still RESERVES, further
  // down: the spec's §4 says take no reservation, but its own §3 argues against
  // the single-row model on the grounds that "under `unlimited` a second
  // redemption would have to overwrite the first, destroying the
  // `startedAt`/`endsAt` the operator surfaces read", which presupposes rows
  // exist. Recording is also what makes a later flip to a real policy mean
  // anything: starting from no history hands every existing buyer a fresh trial
  // on the day it is switched on.
  if (args.policy === 'unlimited') return { eligible: true, policy: args.policy };

  const now = args.now ?? new Date();
  const where: Prisma.TrialRedemptionWhereInput = {
    ...slotHolderWhere(args.applicationId, args.subjectKey, now, args.planId),
    ...(args.policy === 'once_per_plan' && { planId: args.planId }),
  };

  const blocker = await db.trialRedemption.findFirst({
    where,
    orderBy: { createdAt: 'asc' },
    select: { id: true, planId: true, status: true, startedAt: true, endsAt: true },
  });

  return blocker
    ? { eligible: false, policy: args.policy, blockedBy: blocker }
    : { eligible: true, policy: args.policy };
}

/**
 * Refuse a buyer who has already had their trial.
 *
 * Refusing rather than silently charging is the whole point: `checkout-trial.ts`
 * exists because a page that said "free" and a provider that charged today is a
 * dispute, not a rendering bug, and that a buyer is a repeat trialist does not
 * make the surprise charge acceptable. The way through is an explicit
 * acknowledgement from the call site that rendered the price.
 */
export function trialAlreadyUsed(args: {
  planSlug: string;
  blockedByPlanSlug?: string;
  priceLabel?: string;
}): RekeyError {
  const already = args.blockedByPlanSlug
    ? `has already used a free trial of "${args.blockedByPlanSlug}"`
    : 'has already used a free trial';
  const charge = args.priceLabel
    ? `, so subscribing to "${args.planSlug}" would charge ${args.priceLabel} today`
    : `, so subscribing to "${args.planSlug}" would be charged today`;
  return new RekeyError({
    statusCode: 409,
    code: 'BILLING_TRIAL_ALREADY_USED',
    message: `This account ${already} and is not eligible for another${charge}.`,
    fix:
      'Read GET /api/v1/billing/trial-eligibility before offering a trial, and present the paid ' +
      'price to a buyer who is not eligible. To continue at full price, retry with ' +
      '`allowWithoutTrial: true` AND a new Idempotency-Key, once the buyer has been told they ' +
      'will be charged today.',
  });
}

/**
 * Take the slot, before the provider call.
 *
 * A subject already holding a live RESERVED row does not get refused and does
 * not get a second slot: the older row goes RELEASED and a new one is created.
 * Blocking instead, which is what coupons do with
 * `COUPON_CHECKOUT_ALREADY_OPEN`, would tell a buyer who bailed at the
 * provider and came straight back that they must wait 24 hours, a
 * denial-of-sale against the ordinary case. A RELEASED row keeps its session
 * mapping, so if that older session is paid anyway the confirmation still
 * records a truthful CONSUMED row.
 */
export async function reserveTrial(
  db: Db,
  args: {
    applicationId: string;
    subjectKey: string;
    endUserId: string;
    organizationId?: string | null;
    planId: string;
    trialDays: number;
    expiresAt: Date;
  },
): Promise<TrialRedemption> {
  await db.trialRedemption.updateMany({
    where: { applicationId: args.applicationId, subjectKey: args.subjectKey, status: 'RESERVED' },
    data: { status: 'RELEASED' },
  });

  return db.trialRedemption.create({
    data: {
      applicationId: args.applicationId,
      subjectKey: args.subjectKey,
      endUserId: args.endUserId,
      organizationId: args.organizationId ?? null,
      planId: args.planId,
      status: 'RESERVED',
      trialDays: args.trialDays,
      expiresAt: args.expiresAt,
    },
  });
}

/**
 * Bind a reservation to the provider session that carried it.
 *
 * Two steps because the reservation predates the session id, exactly as the
 * coupon reservation does. A throw between the two leaves a RESERVED row with
 * no session, which holds a slot until it expires and confirms against nothing.
 * That is the fail-closed direction, and `releaseTrial` is what keeps it rare.
 */
export async function bindTrialToSession(
  db: Db,
  reservationId: string,
  checkoutSessionId: string,
): Promise<void> {
  await db.trialRedemption.update({
    where: { id: reservationId },
    data: { checkoutSessionId },
  });
}

/** The provider call threw: give the slot back. */
export async function releaseTrial(db: Db, reservationId: string): Promise<void> {
  await db.trialRedemption.updateMany({
    where: { id: reservationId, status: 'RESERVED' },
    data: { status: 'RELEASED' },
  });
}

/**
 * The provider started the trial: record it.
 *
 * Runs POST-COMMIT, outside the transaction that writes money, for the reason
 * `webhooks/apply.ts` already states: a bookkeeping write must never be able to
 * roll back a payment. So it never throws.
 *
 * A confirmation that cannot be recorded clears `expiresAt` rather than logging
 * and moving on, which is the coupon disposition. Leaving the row to age out
 * would fail OPEN for an anti-abuse control and hand the buyer another trial;
 * holding the slot until an operator resolves it fails closed. That is the one
 * place this module deliberately diverges from the coupon precedent, and it is
 * the reason `slotHolderWhere` treats a null expiry as still holding.
 */
export async function consumeTrial(args: {
  applicationId: string;
  checkoutSessionId: string;
  subscriptionId: string | null;
  /** Defaults to the row's own `trialDays` from `startedAt`. */
  endsAt?: Date | null;
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<{ recorded: boolean }> {
  try {
    // Read first, so `endsAt` can come from the days actually sent to the
    // provider rather than from the plan, which changes underneath. Also keeps
    // the common case, a session that carried no trial, to one query.
    //
    // RELEASED is matched on purpose. A buyer holding two payable sessions who
    // pays the older one has a RELEASED row for it, and that trial really did
    // start at the provider, so the truthful record is CONSUMED.
    const row = await prisma.trialRedemption.findFirst({
      where: {
        applicationId: args.applicationId,
        checkoutSessionId: args.checkoutSessionId,
        status: { in: ['RESERVED', 'RELEASED'] },
      },
      select: { id: true, trialDays: true },
    });
    if (!row) return { recorded: false };

    const startedAt = new Date();
    const endsAt =
      args.endsAt !== undefined
        ? args.endsAt
        : row.trialDays != null
          ? new Date(startedAt.getTime() + row.trialDays * 86_400_000)
          : null;

    await prisma.trialRedemption.update({
      where: { id: row.id },
      data: {
        status: 'CONSUMED',
        subscriptionId: args.subscriptionId,
        startedAt,
        endsAt,
        expiresAt: null,
      },
    });
    return { recorded: true };
  } catch (err) {
    // Hold the slot rather than let it age out. Best-effort, and if this write
    // fails too the row keeps its original expiry, the one residual way this
    // can fail open, and it takes two consecutive database failures.
    try {
      await prisma.trialRedemption.updateMany({
        where: {
          applicationId: args.applicationId,
          checkoutSessionId: args.checkoutSessionId,
          status: 'RESERVED',
        },
        data: { expiresAt: null },
      });
    } catch {
      // Deliberately swallowed: see the docblock. Bookkeeping must never throw
      // into a settled payment.
    }
    args.log?.warn(
      { err, checkoutSessionId: args.checkoutSessionId },
      'trial redemption could not be confirmed; slot held pending operator review',
    );
    return { recorded: false };
  }
}

/** How `claimGrantedTrial` decided. */
export type GrantedTrialClaim =
  | { honoured: true; redemptionId: string; replayed: boolean }
  | {
      honoured: false;
      /**
       * `already_used`: the subject has spent their slot under the policy.
       * `attempt_spent`: this very attempt already ran its trial to the end,
       * or belonged to another subject, so re-activating it is not a replay.
       */
      reason: 'already_used' | 'attempt_spent';
      blockedBy: Pick<TrialRedemption, 'id' | 'planId' | 'status' | 'startedAt' | 'endsAt'>;
    };

/**
 * A trial somebody ELSE started, recorded against the same ledger.
 *
 * A checkout reserves before the provider call and consumes on the webhook,
 * because between the two the trial may or may not come to exist. A granted
 * subscription has no such gap: the external system that posted it, or the
 * import that read it, is already running the clock. So the row is written
 * CONSUMED in one step, inside the transaction that writes the subscription,
 * and rolls back with it.
 *
 * `attemptKey` is stored in `checkoutSessionId`, the column the unique key is
 * on, so the ledger's grain stays "one row per attempt". The sender's event id
 * (or the import run) is the attempt: a re-delivered event finds its own row
 * and takes nothing new, a fresh event for the same subscription is a new
 * attempt and is judged like any other.
 *
 * Refuses under the same lock and the same `checkTrialEligibility` the checkout
 * uses, so the two paths cannot disagree about who has had a trial. The caller
 * decides what a refusal means; here it only means "not as a trial".
 */
export async function claimGrantedTrial(
  tx: Prisma.TransactionClient,
  args: {
    applicationId: string;
    subjectKey: string;
    endUserId: string;
    organizationId?: string | null;
    planId: string;
    policy: TrialPolicy;
    attemptKey: string;
    endsAt: Date;
    now?: Date;
  },
): Promise<GrantedTrialClaim> {
  const now = args.now ?? new Date();
  // Same key, and always the second lock after the checkout binding lock, so
  // the pair cannot deadlock. See billing.service.ts.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rekey:trial:${args.applicationId}:${args.subjectKey}`}, 0))`;

  const prior = await tx.trialRedemption.findFirst({
    where: { applicationId: args.applicationId, checkoutSessionId: args.attemptKey },
    select: { id: true, planId: true, status: true, startedAt: true, endsAt: true, subjectKey: true },
  });
  if (prior) {
    const running =
      prior.subjectKey === args.subjectKey &&
      prior.status === 'CONSUMED' &&
      prior.endsAt !== null &&
      prior.endsAt > now;
    if (!running) return { honoured: false, reason: 'attempt_spent', blockedBy: prior };
    // The sender owns the clock; a re-delivery that re-dates its own running
    // trial is not a second trial.
    if (prior.endsAt!.getTime() !== args.endsAt.getTime()) {
      await tx.trialRedemption.update({ where: { id: prior.id }, data: { endsAt: args.endsAt } });
    }
    return { honoured: true, redemptionId: prior.id, replayed: true };
  }

  const eligibility = await checkTrialEligibility(tx, {
    applicationId: args.applicationId,
    subjectKey: args.subjectKey,
    planId: args.planId,
    policy: args.policy,
    now,
  });
  if (!eligibility.eligible) {
    return { honoured: false, reason: 'already_used', blockedBy: eligibility.blockedBy! };
  }

  const row = await tx.trialRedemption.create({
    data: {
      applicationId: args.applicationId,
      subjectKey: args.subjectKey,
      endUserId: args.endUserId,
      organizationId: args.organizationId ?? null,
      planId: args.planId,
      status: 'CONSUMED',
      checkoutSessionId: args.attemptKey,
      trialDays: Math.max(1, Math.ceil((args.endsAt.getTime() - now.getTime()) / 86_400_000)),
      startedAt: now,
      endsAt: args.endsAt,
      expiresAt: null,
    },
    select: { id: true },
  });
  return { honoured: true, redemptionId: row.id, replayed: false };
}

/** Why a plan's trial is unavailable. First match wins, in the order below. */
export type TrialIneligibilityReason =
  | 'PLAN_HAS_NO_TRIAL'
  | 'PLAN_TRIAL_MISCONFIGURED'
  | 'TRIAL_IN_PROGRESS'
  | 'ALREADY_REDEEMED';

export interface TrialEligibilityItem {
  planSlug: string;
  /** The plan's real value, reported even on a misconfigured row. */
  trialDays: number | null;
  eligible: boolean;
  reason: TrialIneligibilityReason | null;
  /** When the blocking trial was consumed, for `ALREADY_REDEEMED`. */
  redeemedAt: string | null;
  /** When the in-progress trial ends, for `TRIAL_IN_PROGRESS`. */
  endsAt: string | null;
}

/**
 * Answer "may this buyer start a trial", per plan, for a pricing page.
 *
 * ADVISORY, exactly like `coupons/validate`. The authoritative decision is
 * taken under the lock in `createCheckoutSession`; two tabs can both read
 * `eligible: true` and only one of them gets the trial. The point is that a
 * pricing page can render "Start 14 days free" or "Subscribe" from the answer
 * rather than from the plan alone, and find out at the button instead of at a
 * 409.
 *
 * Provider-dependent, and the caller is told which provider was resolved: a
 * plan can be unbuyable on one processor and fine on another, so a provider
 * picker should re-read this when the buyer changes it.
 */
export async function resolveTrialEligibility(args: {
  applicationId: string;
  plans: Array<Pick<Plan, 'slug' | 'trialDays' | 'kind' | 'licenseKind'>>;
  subjectKey: string;
  policy: TrialPolicy;
  provider: string;
  /** `capabilities.trials` for `provider`; fail-closed when undeclared. */
  providerRunsTrials: boolean;
  now?: Date;
}): Promise<TrialEligibilityItem[]> {
  const now = args.now ?? new Date();

  // Every row that currently holds or held a slot for this subject, read once
  // rather than per plan.
  const holders = await prisma.trialRedemption.findMany({
    where: slotHolderWhere(args.applicationId, args.subjectKey, now),
    select: {
      planId: true,
      status: true,
      startedAt: true,
      endsAt: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const planIdBySlug = new Map<string, string>();
  if (holders.length > 0) {
    const rows = await prisma.plan.findMany({
      where: { applicationId: args.applicationId, slug: { in: args.plans.map((p) => p.slug) } },
      select: { id: true, slug: true },
    });
    for (const r of rows) planIdBySlug.set(r.slug, r.id);
  }

  return args.plans.map((plan) => {
    const base = { planSlug: plan.slug, trialDays: plan.trialDays ?? null };

    // 1. No trial to offer. Checked first because `resolveCheckoutTrial`
    //    returns null on `trialDays <= 0` before it can refuse anything else,
    //    so nothing below is reachable for such a plan.
    if (plan.trialDays == null || plan.trialDays <= 0) {
      return { ...base, eligible: false, reason: 'PLAN_HAS_NO_TRIAL' as const, redeemedAt: null, endsAt: null };
    }

    // 2. The plan carries a trial this checkout could never honour, so it is
    //    currently UNBUYABLE, checkout answers 400, not a price. Reported
    //    separately from "no trial for you" so a frontend hides the plan
    //    instead of offering a price that leads to a 400, and so the operator
    //    surface can say what is misconfigured.
    if (isOneTimePlan(plan) || !args.providerRunsTrials) {
      return {
        ...base,
        eligible: false,
        reason: 'PLAN_TRIAL_MISCONFIGURED' as const,
        redeemedAt: null,
        endsAt: null,
      };
    }

    if (args.policy === 'unlimited') {
      return { ...base, eligible: true, reason: null, redeemedAt: null, endsAt: null };
    }

    const planId = planIdBySlug.get(plan.slug);
    const relevant =
      args.policy === 'once_per_plan' ? holders.filter((h) => h.planId === planId) : holders;

    // A live RESERVED row of this subject's own, for THIS plan, is not a
    // refusal: it is taken over rather than refused (§3's take-over rule), and
    // reporting it as ineligible would invert the feature, a buyer who bailed
    // at the provider and came back would be told to expect a charge today for
    // the trial the checkout was about to grant them. A reservation on a
    // DIFFERENT plan still blocks under once_per_application. This filters out
    // only that one case rather than re-filtering to CONSUMED, which would
    // also drop the fail-closed null-expiry rows and disagree with checkout.
    const consumed = relevant.filter(
      (h) =>
        !(h.status === 'RESERVED' && h.expiresAt !== null && h.expiresAt > now && h.planId === planId),
    );
    if (consumed.length === 0) {
      return { ...base, eligible: true, reason: null, redeemedAt: null, endsAt: null };
    }

    // 3. A trial running RIGHT NOW, on THIS plan. Scoped to the plan on
    //    purpose: under `once_per_application` a buyer trialling `basic` is
    //    ineligible for `pro`, but "your trial ends on the 3rd" is false copy
    //    on a plan they are not on. Those rows fall through to ALREADY_REDEEMED.
    const running = consumed.find(
      (h) => h.planId === planId && h.endsAt !== null && h.endsAt > now,
    );
    if (running) {
      return {
        ...base,
        eligible: false,
        reason: 'TRIAL_IN_PROGRESS' as const,
        redeemedAt: running.startedAt?.toISOString() ?? null,
        endsAt: running.endsAt?.toISOString() ?? null,
      };
    }

    // 4. Anything else holding the slot under this policy.
    const blocker = consumed[0]!;
    return {
      ...base,
      eligible: false,
      reason: 'ALREADY_REDEEMED' as const,
      redeemedAt: (blocker.startedAt ?? blocker.createdAt).toISOString(),
      endsAt: null,
    };
  });
}
