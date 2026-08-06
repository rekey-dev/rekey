/**
 * Granting a subscription that no payment provider is behind.
 *
 * ## Why this exists
 *
 * Until this module, exactly ONE code path in the product created a
 * `Subscription` row — `billingService.createCheckoutSession` — and it created
 * it `PENDING`. The only thing that ever moved a row to `ACTIVE` was a provider
 * webhook. So a deployment with no payment provider configured had no way to
 * record a sale at all: not through the API, not through the panel, not through
 * the operator MCP. The three subscription routes the API exposes are read,
 * read, and cancel.
 *
 * That is not a hypothetical gap. Rekey Cloud runs with
 * `COMMERCE_CHECKOUT_ENABLED=false` and sells by invoice, so **every** live
 * subscription it has is hand-provisioned — which in practice meant writing SQL
 * against production. A row written that way emits nothing, so the entitlement
 * materialisation, the outbound `subscription.activated` event, and everything
 * downstream of it (the Cloud buyer's workspace being created because they
 * paid) never happened. The buyer paid and then still had to let themselves in.
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
 * who terminates the subscription when its date arrives — see
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
import { advanceBillingPeriod } from './webhooks/period.js';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { BillingConfigSchema } from '@rekey.dev/shared-types';

/**
 * Statuses that already mean "this subscriber is entitled". A grant against one
 * of these is the idempotent no-op — see `grantSubscription`.
 *
 * Same pair `billingService.isEntitled` uses, and for the same reason: PAST_DUE
 * is inside the dunning window, not outside the sale.
 */
const ENTITLED = new Set<Subscription['status']>(['ACTIVE', 'PAST_DUE']);

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
   * When the granted period ends. Defaults to one plan interval from now for a
   * recurring plan, and to null for a one-off (see `resolvePeriodEnd`). Must be
   * in the future — a subscription born already expired entitles nobody and
   * would be reaped by `expireIfDue` on the next read.
   */
  currentPeriodEnd?: Date;
  /** Free-text reason, kept on the row and in the audit trail. */
  note?: string;
}

export interface GrantSubscriptionResult {
  subscription: Subscription;
  /**
   * Whether THIS call performed the activation. False means the subscriber was
   * already entitled on this plan and nothing was written, provisioned or
   * announced — which is what makes a repeated grant safe.
   */
  activated: boolean;
}

/**
 * One-off plans buy a thing, not a period: a credit pack and a perpetual
 * licence have no renewal date to hold. Same predicate `createCheckoutSession`
 * uses to decide between a recurring and a one-time provider flow, so the two
 * paths cannot drift on what "recurring" means.
 */
function isOneTime(plan: { kind: string; licenseKind: string | null }): boolean {
  return plan.kind === 'CREDIT' || (plan.kind === 'LICENSE' && plan.licenseKind !== 'TIMED');
}

/**
 * The period end for a grant.
 *
 * An explicit value always wins — an invoice is for whatever term was agreed,
 * and guessing a year deal is a month is the kind of error nobody notices until
 * renewal. Absent one, a recurring plan gets one interval from now via the same
 * calendar-aware helper the provider period mirror uses (`advanceBillingPeriod`
 * — anniversary billing, not 30-day arithmetic), and a one-off gets null.
 *
 * Null is not a shortcut here. It is what `cancelEffect` reads to decide
 * whether "cancel at the end of the period" is even a meaningful request, and
 * what `entitlementsService.provision` falls back to as the `'initial'` grant
 * anchor for a purchase that happens exactly once.
 */
function resolvePeriodEnd(
  plan: { kind: string; licenseKind: string | null; interval: string | null },
  explicit: Date | undefined,
  now: Date,
): Date | null {
  if (explicit !== undefined) return explicit;
  if (isOneTime(plan)) return null;
  return advanceBillingPeriod(now, plan.interval);
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
 * `applyCheckoutCompleted` stamp a `providerSubId` onto the granted row — which
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
  return { ...base, grant: { ...entry, retiredCheckoutSessions: retired } } as Prisma.InputJsonValue;
}

export const subscriptionGrantsService = {
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
   * bound is the contract — granting twice must cost the same as granting once.
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
   * A row in any other state — PENDING (a checkout that never completed),
   * CANCELED or EXPIRED — IS activated. That is the one place this diverges
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
        fix: 'Pass a `currentPeriodEnd` in the future, or omit it to get one plan interval from now.',
      });
    }

    const key = { applicationId, endUserId: endUser.id, planId: plan.id };

    const run = async (): Promise<{
      subscription: Subscription;
      activated: boolean;
      deliveryIds: string[];
    }> =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.subscription.findUnique({
          where: { applicationId_endUserId_planId: key },
        });
        if (existing && ENTITLED.has(existing.status)) {
          return { subscription: existing, activated: false, deliveryIds: [] as string[] };
        }

        const data = {
          status: 'ACTIVE' as const,
          provider: null,
          providerSubId: null,
          currentPeriodEnd,
          // A re-grant of a subscription that was scheduled to end, or had
          // ended, must not carry the old termination forward: `expireIfDue`
          // would read the stale `cancelAt`, find it in the past, and cancel
          // the grant on the very next portal load.
          cancelAt: null,
          canceledAt: null,
          beneficiaryOrgId: input.organizationId ?? null,
          metadata: grantMetadata(existing?.metadata ?? null, {
            grantedAt: now.toISOString(),
            note: input.note ?? null,
            // Kept so a hand-grant over a lapsed provider subscription does not
            // erase which provider it used to be — see the module docblock.
            previousProvider: existing?.provider ?? null,
            previousProviderSubId: existing?.providerSubId ?? null,
          }),
        };

        if (!existing) {
          const created = await tx.subscription.create({ data: { ...key, ...data } });
          return {
            subscription: created,
            activated: true,
            deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.activated', created.id),
          };
        }

        // Conditional on the row STILL not being entitled, and count-checked.
        // Two concurrent grants both read the pre-transaction status, and a
        // plain `update` would let the loser proceed on the winner's row and
        // enqueue a second `subscription.activated` for one sale. Postgres
        // re-evaluates this predicate after the winner releases the row lock,
        // so the loser updates nothing and announces nothing — the same shape
        // `expireIfDue` uses in billing.service.ts.
        const { count } = await tx.subscription.updateMany({
          where: { id: existing.id, status: { notIn: [...ENTITLED] } },
          data,
        });
        const row = await tx.subscription.findUniqueOrThrow({ where: { id: existing.id } });
        if (count === 0) {
          return { subscription: row, activated: false, deliveryIds: [] as string[] };
        }
        return {
          subscription: row,
          activated: true,
          deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.activated', row.id),
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
      const won = await prisma.subscription.findUniqueOrThrow({
        where: { applicationId_endUserId_planId: key },
      });
      return { subscription: won, activated: false };
    }
    const { subscription, activated, deliveryIds } = outcome;

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
    return { subscription, activated: true };
  },
};

/** Resolve the subscriber by id or email, always scoped to the Application. */
async function resolveEndUser(
  applicationId: string,
  input: Pick<GrantSubscriptionInput, 'endUserId' | 'email'>,
): Promise<{ id: string }> {
  const endUser = input.endUserId
    ? await prisma.endUser.findFirst({
        where: { id: input.endUserId, applicationId },
        select: { id: true },
      })
    : await prisma.endUser.findUnique({
        // Stored lowercased at sign-up; an operator typing the address off an
        // invoice will not match the casing.
        where: { applicationId_email: { applicationId, email: (input.email ?? '').toLowerCase() } },
        select: { id: true },
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
  return endUser;
}
