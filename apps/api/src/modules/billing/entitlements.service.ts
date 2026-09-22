/**
 * Plan entitlements, the bundle of benefits a plan grants.
 *
 * A `Plan` has many `PlanEntitlement` rows (see schema). On a subscription
 * becoming ACTIVE (and on renewal), the **provisioner** materializes those
 * entitlements onto the subscriber, idempotently:
 *
 *   CREDIT  → grant N credits to the CreditBalance (per period)
 *   LICENSE → issue a License (idempotent: one per (app, endUser, plan))
 *   USAGE   → no provisioning; the included quota is enforced at usage.record
 *             time as a hard cap (see `includedQuotaFor` + usage.service)
 *   FEATURE → nothing to provision; resolved at read time by the app
 *
 * Back-compat: a plan with NO explicit entitlement rows is provisioned from
 * its legacy `kind` fields (`synthesizeLegacy`), so existing plans keep working
 * unchanged. This generalizes the old per-kind `maybeIssueLicenseFor` /
 * `maybeGrantCreditsFor` handlers into one entitlement-driven engine.
 *
 * Subject = the subscription's owner end-user, or, when the sub names a
 * `beneficiaryOrgId`, the org pool (owner+beneficiary, ORG_BILLING.md).
 * Credits, feature access, and license seats all route to that beneficiary
 * through a single `beneficiary` resolution in `provision`.
 */

import type {
  EntitlementValueType,
  LicenseKind,
  Plan,
  PlanEntitlement,
  PlanEntitlementKind,
  Prisma,
  Subscription,
  SubscriptionStatus,
  PlanKind,
} from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { isOneTimePlan } from './plan-kind.js';
import { assertTrialMaterialisesNothing } from '../plans/plans.service.js';
import { RekeyError } from '../../lib/error.js';
import { BillingConfigSchema, ENTITLING_SUBSCRIPTION_STATUSES } from '@rekey.dev/shared-types';
import { creditsService } from '../credits/credits.service.js';
import { licensesService } from '../licenses/licenses.service.js';

/**
 * Free-tier fallback (#36): the Application's `billingConfig.defaultPlanSlug`
 * plan, applied at read time on top of what a subject's subscriptions grant.
 * Returns the active plan or null when no default is configured / the slug is
 * stale. Callers decide how much of it survives: withheld for a key a
 * per-subscription override names, and otherwise able only to raise a value.
 * Read-only, only FEATURE flags + included USAGE quota are honoured by callers
 * (CREDIT/LICENSE are stateful and require a real subscription).
 */
async function loadDefaultPlan(applicationId: string): Promise<Plan | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { billingConfig: true },
  });
  if (!app) return null;
  const parsed = BillingConfigSchema.safeParse(app.billingConfig);
  const slug = parsed.success ? parsed.data.defaultPlanSlug : undefined;
  if (!slug) return null;
  return prisma.plan.findFirst({ where: { applicationId, slug, active: true } });
}

/**
 * Subscription statuses that entitle the subscriber to what they bought.
 *
 * PAST_DUE is one of them. A card retry failing is the START of the dunning
 * window, not the end of the subscription, the provider is still retrying,
 * `getCurrentSubscription` still returns the row, the portal still shows the
 * plan, and dunning exists precisely to give the customer time to fix it.
 * Resolving entitlements for ACTIVE only contradicted all of that: the first
 * failed charge silently stripped every feature flag the customer had paid
 * for, days or weeks before they had actually run out of chances to pay. A
 * customer who bought a three-workspace allowance was reduced to the default
 * of one while their subscription was still, by every other measure, live.
 *
 * CANCELED and EXPIRED are terminal and are correctly excluded; PENDING is a
 * checkout that never completed and never entitled anyone.
 */
// TRIALING entitles. A trial the subscriber cannot use is not a trial, and it
// has to be added here in the same change that starts EMITTING the status:
// `mapStripeSubStatus` folded Stripe's `trialing` into ACTIVE, so trials
// configured in the Stripe dashboard already entitle today. Emitting TRIALING
// without entitling it would lock out every one of them.
const ENTITLING_STATUSES: SubscriptionStatus[] = [...ENTITLING_SUBSCRIPTION_STATUSES];

/**
 * The `where` fragment that defines "currently entitling".
 *
 * Status alone is not enough. A subscription scheduled to cancel at the end of
 * its period stays ACTIVE until something terminates it, the provider's
 * webhook for a provider-backed row, and `expireIfDue` on read for a row
 * without one. That lazy expiry only runs from `getCurrentSubscription`, and
 * entitlement resolution queries the table directly, so a provider-less row
 * whose `cancelAt` had passed kept granting entitlements until some unrelated
 * portal read happened to flip it. Rekey Cloud's subscriptions are all
 * provider-less, so that was all of them.
 *
 * Fixed here as a FILTER rather than another write. A read path that has to
 * mutate before it can answer is a race and a hot-path write; excluding the
 * lapsed row is neither, it is correct the first time, and it covers every
 * future caller that forgets the expiry exists. `expireIfDue` still runs on
 * the portal read to settle the row's status and emit the event, this makes
 * the entitlement answer independent of whether that has happened yet.
 *
 * Provider-backed rows are filtered the same way, which they did not used to
 * be. The carve-out said the provider is the authority on when a subscription
 * truly ends, so pre-empting it here would cut access off before the provider
 * agreed it had lapsed. That was sound only where the provider can schedule a
 * cancellation and will send an event when it lands.
 *
 * PayPal can do neither. Its only cancel is immediate, so a period-end request
 * terminates the agreement at once and the paid period is held open on our side
 * instead, `applySubscriptionStatusMirror` deliberately declines to let
 * PayPal's own CANCELLED event shorten it. No further event is coming, so under
 * the carve-out the lapsed row went on granting everything the buyer had
 * cancelled, indefinitely, until an unrelated portal read happened to run
 * `expireIfDue`. That is the exact defect this filter was written to fix,
 * wearing a provider id.
 *
 * The precondition that makes it safe is the same either way: `cancelAt` on a
 * provider-backed row is only ever written after the provider CONFIRMED the
 * cancellation, `cancelSubscription` throws on failure and the row is left
 * untouched, or mirrored from the provider's own schedule. A date in the past
 * therefore means the provider has agreed.
 */
function stillEntitling(now: Date) {
  return {
    status: { in: ENTITLING_STATUSES },
    AND: [
      { OR: [{ cancelAt: null }, { cancelAt: { gt: now } }] },
      // A term that has elapsed stops entitling, but only where the term is
      // the last word on the matter.
      //
      // `grantSubscription` writes `provider: null, providerSubId: null` and a
      // `currentPeriodEnd`, and nothing will ever renew that row. Resolution
      // read status alone, so "grant them fourteen days" was a permanent
      // grant: full access forever, the only trace a `currentPeriodEnd` in the
      // past that nothing looked at. Every comped, invoice-provisioned and
      // trial subscription had the same shape, which is why nothing
      // time-boxed could be sold or comped safely.
      //
      // Provider-backed rows are deliberately exempt. There `currentPeriodEnd`
      // is a RENEWAL date, moved forward by a webhook that can arrive late; a
      // renewal that has happened but not yet been delivered would otherwise
      // de-entitle a customer who has just paid. Over-entitling for the length
      // of a webhook delay is the cheaper mistake, and the provider remains
      // the authority on its own subscriptions.
      //
      // A null `currentPeriodEnd` is an open-ended grant and keeps entitling,
      // which is what "comp this account indefinitely" has always meant.
      {
        OR: [
          { providerSubId: { not: null } },
          { currentPeriodEnd: null },
          { currentPeriodEnd: { gt: now } },
        ],
      },
    ],
  };
}

export interface ResolvedEntitlement {
  kind: PlanEntitlementKind;
  key: string;
  valueType: EntitlementValueType | null;
  value: string | null;
  quantity: number | null;
  /** USAGE only, credits per unit past `quantity`. Null = hard cap. */
  creditsPerUnit: number | null;
  licenseKind: LicenseKind | null;
  rollover: boolean;
}

/** Parse a FEATURE entitlement's stringified value into its typed JS form. */
export function parseFeatureValue(
  valueType: EntitlementValueType | null,
  value: string | null,
): boolean | number | string | null {
  if (value === null) return valueType === 'BOOL' ? false : null;
  switch (valueType) {
    case 'BOOL':
      return value === 'true';
    case 'INT': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'STRING':
    default:
      return value;
  }
}

/**
 * Does this subject hold a subscription that should suppress the free tier?
 *
 * Only a recurring plan does. A one-off purchase, a credit pack, a licence,
 * creates a `Subscription` row too, because that is where provisioning hangs,
 * but buying credits is not "being on a plan". Keying the free-tier fallback
 * on `subs.length === 0` therefore deleted the free tier the moment somebody
 * topped up: a user with 1,000 included calls bought credits to prepare for
 * overage and lost the 1,000, which is the exact user who was trying to do the
 * right thing.
 */
function suppressesFreeTier(subs: Array<{ plan: { kind: PlanKind } }>): boolean {
  return subs.some((s) => s.plan.kind === 'SUBSCRIPTION' || s.plan.kind === 'USAGE');
}

/**
 * The `KIND:key` pairs a per-subscription OVERRIDE speaks about, across every
 * entitling subscription the subject holds.
 *
 * The free tier loses to an override and not to a plan row, and the difference
 * is the whole point. An override is a deliberate per-customer deviation, so it
 * has to be authoritative or it is not an override. A plan row is not: buying a
 * credit pack is a top-up, not being on a plan, which is exactly what
 * `suppressesFreeTier` already encodes and what `entitlement-leaks.test.ts`
 * pins. Letting a plan row withhold the default would take a free tier away
 * from a customer for topping up, which is the opposite of the intent, and it
 * would do so to subjects who have no override at all.
 */
function overriddenKeys(
  subs: ReadonlyArray<{ entitlementOverrides: Prisma.JsonValue | null }>,
): Set<string> {
  const keys = new Set<string>();
  for (const s of subs) {
    const raw = s.entitlementOverrides;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      // Defensive. `mergePatch` deletes on null rather than storing one, and a
      // test pins that, so a null can only arrive from a pre-module row or a
      // direct database write. Skipped rather than treated as an override
      // because `applyOverrides` would coerce it -- `String(null)` is "null" and
      // `Number(null)` is 0 -- which is not a deal anybody sold.
      if (v !== null) keys.add(k);
    }
  }
  return keys;
}

function shape(e: PlanEntitlement): ResolvedEntitlement {
  return {
    kind: e.kind,
    key: e.key,
    valueType: e.valueType,
    value: e.value,
    quantity: e.quantity,
    creditsPerUnit: e.creditsPerUnit,
    licenseKind: e.licenseKind,
    rollover: e.rollover,
  };
}

/**
 * Any Prisma client: the global singleton, or a `$transaction` client. The
 * read paths below take one so a caller already inside a transaction (the
 * billing outbox, see webhooks/billing-events.ts) resolves entitlements
 * through ITS connection instead of taking a second one from the pool while
 * holding the first.
 */
type EntitlementDbClient = Prisma.TransactionClient;

export const entitlementsService = {
  /** List a plan's explicit entitlement rows. */
  async listForPlan(
    planId: string,
    client: EntitlementDbClient = prisma,
  ): Promise<PlanEntitlement[]> {
    return client.planEntitlement.findMany({
      where: { planId },
      orderBy: [{ kind: 'asc' }, { key: 'asc' }],
    });
  },

  /**
   * Resolve several plans' entitlements in ONE query, keyed by plan id.
   *
   * The bulk form of `resolveForPlan`, for the read paths that hold a set of
   * subscriptions: `GET /api/v1/billing/entitlements` is called by customer
   * apps on every page load, and resolving each subscription's plan in turn
   * was one `planEntitlement.findMany` per subscription, awaited in sequence.
   * A plan with no explicit rows still falls back to `synthesizeLegacy`, same
   * as the single-plan path.
   */
  async resolveForPlans(
    plans: readonly Plan[],
    client: EntitlementDbClient = prisma,
  ): Promise<Map<string, ResolvedEntitlement[]>> {
    const out = new Map<string, ResolvedEntitlement[]>();
    if (plans.length === 0) return out;
    // Distinct ids: two subscriptions on the same plan must not widen the IN.
    const planIds = [...new Set(plans.map((p) => p.id))];
    const rows = await client.planEntitlement.findMany({
      where: { planId: { in: planIds } },
      orderBy: [{ kind: 'asc' }, { key: 'asc' }],
    });
    const byPlan = new Map<string, PlanEntitlement[]>();
    for (const row of rows) {
      const list = byPlan.get(row.planId);
      if (list) list.push(row);
      else byPlan.set(row.planId, [row]);
    }
    for (const plan of plans) {
      if (out.has(plan.id)) continue;
      const explicit = byPlan.get(plan.id);
      out.set(plan.id, explicit ? explicit.map(shape) : synthesizeLegacy(plan));
    }
    return out;
  },

  /** Create or update one entitlement on a plan (keyed by (plan, kind, key)). */
  async upsert(args: {
    planId: string;
    kind: PlanEntitlementKind;
    key?: string;
    valueType?: EntitlementValueType | null;
    value?: string | null;
    quantity?: number | null;
    /** USAGE only, credits per unit past `quantity`. Null/absent = hard cap. */
    creditsPerUnit?: number | null;
    licenseKind?: LicenseKind | null;
    rollover?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<PlanEntitlement> {
    const key = args.key ?? '';
    this.validate({ ...args, key });
    // The other half of the trial guard. A plan can be created with a trial and
    // FEATURE rows, then have a CREDIT row added here, which is the same
    // day-0 giveaway arriving by the other door.
    if (args.kind === 'CREDIT' || args.kind === 'LICENSE') {
      const plan = await prisma.plan.findUnique({
        where: { id: args.planId },
        select: { slug: true, trialDays: true },
      });
      if (plan) {
        assertTrialMaterialisesNothing({
          planSlug: plan.slug,
          trialDays: plan.trialDays,
          kinds: [args.kind],
        });
      }
    }
    return prisma.planEntitlement.upsert({
      where: { planId_kind_key: { planId: args.planId, kind: args.kind, key } },
      create: {
        planId: args.planId,
        kind: args.kind,
        key,
        valueType: args.valueType ?? null,
        value: args.value ?? null,
        quantity: args.quantity ?? null,
        creditsPerUnit: args.creditsPerUnit ?? null,
        licenseKind: args.licenseKind ?? null,
        rollover: args.rollover ?? false,
        ...(args.metadata !== undefined && { metadata: args.metadata as never }),
      },
      update: {
        valueType: args.valueType ?? null,
        value: args.value ?? null,
        quantity: args.quantity ?? null,
        creditsPerUnit: args.creditsPerUnit ?? null,
        licenseKind: args.licenseKind ?? null,
        rollover: args.rollover ?? false,
        ...(args.metadata !== undefined && { metadata: args.metadata as never }),
      },
    });
  },

  async remove(planId: string, id: string): Promise<{ removed: boolean }> {
    const row = await prisma.planEntitlement.findUnique({ where: { id } });
    if (!row || row.planId !== planId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'PLAN_ENTITLEMENT_NOT_FOUND',
        message: 'Entitlement not found on this plan.',
        fix: 'List the plan entitlements to confirm the id.',
      });
    }
    await prisma.planEntitlement.delete({ where: { id } });
    return { removed: true };
  },

  /** Per-kind shape validation. Throws BILLING_* on bad input. */
  validate(args: {
    kind: PlanEntitlementKind;
    key: string;
    valueType?: EntitlementValueType | null;
    value?: string | null;
    quantity?: number | null;
    creditsPerUnit?: number | null;
    licenseKind?: LicenseKind | null;
  }): void {
    const bad = (message: string, fix: string): never => {
      throw new RekeyError({ statusCode: 400, code: 'PLAN_ENTITLEMENT_INVALID', message, fix });
    };
    switch (args.kind) {
      case 'FEATURE':
        if (!args.key) bad('FEATURE entitlement needs a `key`.', 'e.g. "advanced_reporting".');
        if (!args.valueType) bad('FEATURE entitlement needs a `valueType`.', 'BOOL | INT | STRING.');
        if (args.value == null || args.value === '')
          bad('FEATURE entitlement needs a `value`.', 'e.g. "true" or "50".');
        if (args.valueType === 'INT' && !Number.isFinite(Number(args.value)))
          bad('FEATURE INT value must be numeric.', 'Pass a number like "50".');
        break;
      case 'CREDIT':
        if (!args.quantity || args.quantity <= 0)
          bad('CREDIT entitlement needs a positive `quantity`.', 'Credits granted per period.');
        break;
      case 'LICENSE':
        if (!args.licenseKind) bad('LICENSE entitlement needs a `licenseKind`.', 'PERPETUAL | TIMED | SEATS.');
        if (args.licenseKind === 'SEATS' && (!args.quantity || args.quantity < 1))
          bad('SEATS license needs `quantity` >= 1 (seats).', 'Set seats, or use PERPETUAL/TIMED.');
        break;
      case 'USAGE':
        if (!args.key) bad('USAGE entitlement needs a meter `key`.', 'The meter slug, e.g. "api_calls".');
        // A quota of zero is meaningful once the entitlement carries a price:
        // it says "no free units, charge from the first one". Without a price
        // it says nothing at all, an entitlement granting no units and
        // costing nothing is indistinguishable from not having one, so it is
        // still refused.
        if (args.quantity == null || args.quantity < 0)
          bad('USAGE entitlement needs `quantity` (included units), 0 or more.', 'Set the included quota.');
        if (args.quantity === 0 && args.creditsPerUnit == null)
          bad(
            'A USAGE entitlement with no included units must set `creditsPerUnit`.',
            'Either include some units, or price the meter so usage past zero can be paid for.',
          );
        break;
    }
  },

  /**
   * The effective entitlements for a plan: its explicit rows, or, when it has
   * none, a single synthesized entitlement from the legacy `kind` fields.
   */
  async resolveForPlan(
    plan: Plan,
    client: EntitlementDbClient = prisma,
  ): Promise<ResolvedEntitlement[]> {
    const rows = await this.listForPlan(plan.id, client);
    if (rows.length > 0) return rows.map(shape);
    return synthesizeLegacy(plan);
  },

  /**
   * What ONE subscription actually grants: its plan's entitlements with that
   * subscription's `entitlementOverrides` applied on top.
   *
   * The plan-level view (`resolveForPlan`) is not what a subscriber holds,
   * a per-subscription override is how a bespoke deal is sold without minting a
   * private plan, and reading the plan alone silently ignores it. Every caller
   * that asks "what did THIS buyer purchase" wants this one; `provision` and
   * `resolveForEndUser` already compose the same two steps inline.
   */
  async resolveForSubscription(
    sub: Subscription,
    client: EntitlementDbClient = prisma,
  ): Promise<ResolvedEntitlement[]> {
    const plan = await client.plan.findUniqueOrThrow({ where: { id: sub.planId } });
    return applyOverrides(await this.resolveForPlan(plan, client), sub.entitlementOverrides);
  },

  /**
   * Materialize a subscription's plan entitlements onto the subscriber.
   * Idempotent per (subscription, period), safe under webhook replay + renewal.
   *
   * `firstPeriod`: anchor this grant to the subscription's FIRST period
   * (`'initial'`) regardless of `currentPeriodEnd`. The first period is
   * provisioned twice, once at `checkout.session.completed` (when
   * `currentPeriodEnd` is still null) and once at the first `invoice.paid`
   * (`billing_reason: subscription_create`). Stripe does NOT order webhooks, so
   * `customer.subscription.updated` can set `currentPeriodEnd` BEFORE that first
   * invoice arrives, if it does, the invoice would otherwise anchor on the new
   * period end, NOT collide with the checkout grant, and hand out the first
   * period's credits/license-term a second time. Forcing both first-period
   * provisions onto the `'initial'` anchor makes them collide → exactly one
   * grant. Renewals (`subscription_cycle`) omit the flag and anchor on
   * `currentPeriodEnd`, so each later period still refills/extends once.
   */
  async provision(args: {
    subscription: Subscription;
    log?: FastifyBaseLogger;
    firstPeriod?: boolean;
    /**
     * What this particular PURCHASE was, for a plan that has no period.
     *
     * A provider checkout session id, or a payment id. Only read for a one-off
     * plan; a recurring plan anchors on its period, which is what makes a
     * renewal refill exactly once. See the anchor below for why a one-off needs
     * its own identity.
     */
    purchaseRef?: string;
  }): Promise<void> {
    const sub = args.subscription;
    const [plan, application, endUser] = await Promise.all([
      prisma.plan.findUniqueOrThrow({ where: { id: sub.planId } }),
      prisma.application.findUniqueOrThrow({ where: { id: sub.applicationId } }),
      prisma.endUser.findUniqueOrThrow({ where: { id: sub.endUserId } }),
    ]);
    const entitlements = applyOverrides(await this.resolveForPlan(plan), sub.entitlementOverrides);
    // The idempotency anchor for everything provisioned below.
    //
    // A recurring plan anchors on its PERIOD, so a replayed webhook inside one
    // period is a no-op and the next period refills exactly once.
    //
    // A one-off plan has no period: `currentPeriodEnd` is never written, so
    // BOTH branches of that expression yield `'initial'` forever. Combined with
    // the checkout upsert reusing the same `(applicationId, endUserId, planId)`
    // row, so `sub.id` does not change either, a second purchase computed a
    // key identical to the first, `credits.service` saw the prior entry and
    // returned `{ applied: false }`, and the buyer was charged again and
    // credited nothing (#490). So a one-off anchors on the purchase instead.
    //
    // Falls back to `'initial'` when no ref is supplied, which preserves the
    // old behaviour for `grant.service`, a hand-grant is meant to be
    // idempotent, and re-running one should not mint a second pack.
    const oneTime = isOneTimePlan(plan);
    const period = oneTime
      ? args.purchaseRef ?? 'initial'
      : args.firstPeriod
        ? 'initial'
        : sub.currentPeriodEnd?.toISOString() ?? 'initial';
    // Beneficiary (ORG_BILLING.md): the org when the sub names one, else the
    // owner end-user. Credits + feature access flow to the beneficiary.
    const beneficiary = sub.beneficiaryOrgId
      ? { organizationId: sub.beneficiaryOrgId }
      : { endUserId: endUser.id };

    // A plan may carry more than one CREDIT entitlement, the unique key is
    // (planId, kind, key), so `CREDIT:base = 500` plus `CREDIT:bonus = 200` is
    // legal, and the tenant API and MCP both accept it. The anchor below used
    // to omit `e.key`, so both grants shared one idempotency key and the second
    // was silently swallowed as a duplicate: the buyer paid for 700 credits and
    // received 500.
    //
    // Keying it fixes that going forward and creates one transitional hazard:
    // a subscription already provisioned in its CURRENT period under the old
    // key would see a new key, treat the period as ungranted, and grant again.
    // `legacyRef` is the old row. The first CREDIT entitlement whose amount
    // matches it is treated as already granted and skipped, consuming the guard
    // so it can match at most once.
    //
    // Matched on AMOUNT, not position: `resolveForPlan` orders by (kind, key),
    // so adding a row with an alphabetically earlier key changes which
    // entitlement comes first, and a position-based guard would then skip the
    // wrong one and re-grant the other.
    //
    // Remove after 2027-09, by which point every annual subscription has
    // renewed at least once and no row can still be on a pre-change period.
    let legacyCredit = await prisma.creditLedger
      .findUnique({
        where: {
          applicationId_subjectKey_idempotencyKey: {
            applicationId: application.id,
            // Same subject the grant below writes under, so the legacy guard
            // still finds the row it is looking for now that the ledger's
            // uniqueness includes the subject (#492).
            subjectKey: beneficiary.organizationId
              ? `o:${beneficiary.organizationId}`
              : `u:${beneficiary.endUserId}`,
            idempotencyKey: `purchase:ent:${sub.id}:CREDIT:${period}`,
          },
        },
        select: { delta: true },
      })
      .catch(() => null);

    for (const e of entitlements) {
      if (e.kind === 'CREDIT' && e.quantity && e.quantity > 0) {
        if (legacyCredit !== null && legacyCredit.delta === e.quantity) {
          legacyCredit = null;
          continue;
        }
        await creditsService.grantFromPurchase({
          applicationId: application.id,
          ...beneficiary,
          amount: e.quantity,
          // Idempotency anchor: one grant per (subscription, entitlement, period).
          paymentRef: `ent:${sub.id}:CREDIT:${e.key}:${period}`,
          metadata: { source: 'entitlement', planId: plan.id, subscriptionId: sub.id },
        });
      } else if (e.kind === 'LICENSE' && e.licenseKind) {
        // Owner+beneficiary (ORG_BILLING §3): an org-beneficiary sub issues ONE
        // license pooled to the org (its `seatsAllowed` seats are shared by the
        // team's machines); a personal sub issues to the owner end-user.
        // Idempotent per pool: at most one license per (app, pool, plan,
        // entitlement key), so renewal/webhook replay never over-issues.
        //
        // The entitlement KEY is part of that identity. Without it a plan
        // carrying `LICENSE:a` and `LICENSE:b` resolved both to the same
        // licence: this loop hits each in turn, and whatever the first wrote
        // the second silently overwrote (#488).
        const existing = await prisma.license.findFirst({
          where: {
            entitlementKey: e.key,
            ...(sub.beneficiaryOrgId
              ? { applicationId: application.id, organizationId: sub.beneficiaryOrgId, planId: plan.id }
              : {
                  applicationId: application.id,
                  endUserId: endUser.id,
                  organizationId: null,
                  planId: plan.id,
                }),
          },
        });
        if (existing) {
          // A TIMED license must be EXTENDED on renewal, the buyer is charged
          // every period, so its term has to roll forward. Push `expiresAt` out
          // by the plan's duration from `max(currentExpiry, now)` (so a late
          // renewal leaves no gap, an early one stacks the term) and clear any
          // stale EXPIRED status. PERPETUAL/SEATS have no term to extend, so they
          // keep the idempotent skip.
          //
          // Idempotent per (subscription, period), same anchor the CREDIT grant
          // uses, so a same-period replay (e.g. invoice.paid + the synonymous
          // invoice.payment_succeeded) never double-extends, while the next
          // billing period (a distinct `currentPeriodEnd`) rolls the term once.
          if (
            existing.kind === 'TIMED' &&
            plan.licenseDurationDays &&
            existing.revokedAt === null
          ) {
            const meta = (existing.metadata ?? {}) as Record<string, unknown>;
            const anchor = `ent:${sub.id}:LICENSE:${period}`;
            if (meta.lastProvisionedPeriod !== anchor) {
              const base =
                existing.expiresAt && existing.expiresAt > new Date()
                  ? existing.expiresAt
                  : new Date();
              const extended = new Date(base.getTime() + plan.licenseDurationDays * 86_400_000);
              await prisma.license.update({
                where: { id: existing.id },
                data: {
                  expiresAt: extended,
                  status: 'ACTIVE',
                  metadata: { ...meta, lastProvisionedPeriod: anchor } as Prisma.InputJsonValue,
                },
              });
            }
          }
          continue;
        }
        const expiresAt =
          e.licenseKind === 'TIMED' && plan.licenseDurationDays
            ? new Date(Date.now() + plan.licenseDurationDays * 86_400_000)
            : undefined;
        const seatsAllowed = e.licenseKind === 'SEATS' && e.quantity ? e.quantity : undefined;
        // Stamp this period's anchor on a TIMED license at issue time, so a
        // later same-period renewal event (which finds `existing`) treats the
        // term as already covering this period and doesn't re-extend it. Later
        // periods carry a distinct anchor and do extend.
        const issueMetadata =
          e.licenseKind === 'TIMED' ? { lastProvisionedPeriod: `ent:${sub.id}:LICENSE:${period}` } : undefined;
        await licensesService.issue({
          application,
          endUser, // owner/holder, always set
          planId: plan.id,
          kind: e.licenseKind,
          entitlementKey: e.key,
          ...(sub.beneficiaryOrgId !== null && { organizationId: sub.beneficiaryOrgId }),
          ...(expiresAt !== undefined && { expiresAt }),
          ...(seatsAllowed !== undefined && { seatsAllowed }),
          ...(issueMetadata !== undefined && { metadata: issueMetadata }),
        });
      }
      // FEATURE → resolved at read time. USAGE → hard cap enforced at
      // usage.record time (includedQuotaFor); nothing to materialize here.
    }
    args.log?.info({ subscriptionId: sub.id, count: entitlements.length }, 'entitlements provisioned');
  },

  /**
   * Resolve the entitlements a subject currently holds across their ENTITLING
   * subscriptions.
   *
   * Default (no `organizationId`): the **end-user view**, unions the user's
   * own subscriptions with subscriptions whose beneficiary is an org they
   * belong to (so members see team-granted features); credit balance is the
   * user's personal pool.
   *
   * With `organizationId`: the **org view**, only subs whose beneficiary is
   * that org; credit balance is the shared org pool. (Membership must be
   * checked by the caller/route.)
   *
   * Feature flags merge: booleans OR-true, numbers max, strings last-wins.
   *
   * PAST_DUE counts as entitling here, see ENTITLING_STATUSES.
   */
  async resolveForEndUser(
    applicationId: string,
    endUserId: string,
    opts?: { organizationId?: string },
  ): Promise<{
    features: Record<string, boolean | number | string>;
    entitlements: ResolvedEntitlement[];
    creditBalance: number;
  }> {
    const { features, entitlements, subject } = await this.resolveGrants(applicationId, endUserId, opts);
    const creditBalance = await creditsService.getBalance(applicationId, subject);
    return { features, entitlements, creditBalance };
  },

  /**
   * One feature's value for the same subject `resolveForEndUser` resolves,
   * from the same resolution, without reading the credit balance.
   *
   * `granted` is `Boolean(value)`, the test every `if (features.x)` gate
   * makes, so a false flag, a zero limit and an absent key all read as not
   * granted. `value` is null for an absent key.
   */
  async resolveFeature(
    applicationId: string,
    endUserId: string,
    key: string,
    opts?: { organizationId?: string },
  ): Promise<{ key: string; granted: boolean; value: boolean | number | string | null }> {
    const { features } = await this.resolveGrants(applicationId, endUserId, opts);
    const value = Object.hasOwn(features, key) ? features[key]! : null;
    return { key, granted: Boolean(value), value };
  },

  /**
   * The subscriptions-and-free-tier half of `resolveForEndUser`: the resolved
   * rows and the merged feature map, plus the subject the credit balance
   * belongs to. Split out so a single-feature check does not pay for the
   * balance read.
   */
  async resolveGrants(
    applicationId: string,
    endUserId: string,
    opts?: { organizationId?: string },
  ): Promise<{
    features: Record<string, boolean | number | string>;
    entitlements: ResolvedEntitlement[];
    subject: { endUserId?: string; organizationId?: string };
  }> {
    let subs;
    let subject: { endUserId?: string; organizationId?: string };
    if (opts?.organizationId) {
      subs = await prisma.subscription.findMany({
        where: {
          applicationId,
          beneficiaryOrgId: opts.organizationId,
          ...stillEntitling(new Date()),
        },
        include: { plan: true },
        // Deterministic, because STRING features merge last-wins below. Without
        // an order, which subscription wins a STRING key is Postgres row order
        // and can flip after an unrelated UPDATE, so a subject holding two plans
        // saw a value change between page loads with nothing having changed.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      subject = { organizationId: opts.organizationId };
    } else {
      const memberships = await prisma.organizationMembership.findMany({
        where: { endUserId, organization: { applicationId } },
        select: { organizationId: true },
      });
      const orgIds = memberships.map((m) => m.organizationId);
      subs = await prisma.subscription.findMany({
        where: {
          applicationId,
          // `stillEntitling` returns its own AND, so the subject match goes
          // under a sibling AND rather than colliding with it.
          AND: [
            stillEntitling(new Date()),
            {
              OR: [
                { endUserId },
                ...(orgIds.length > 0 ? [{ beneficiaryOrgId: { in: orgIds } }] : []),
              ],
            },
          ],
        },
        include: { plan: true },
        // Deterministic, because STRING features merge last-wins below. Without
        // an order, which subscription wins a STRING key is Postgres row order
        // and can flip after an unrelated UPDATE, so a subject holding two plans
        // saw a value change between page loads with nothing having changed.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      subject = { endUserId };
    }

    // One query for every subscription's plan entitlements, then the
    // per-subscription overrides applied in memory. This is the endpoint
    // customer apps call on every page load, and it used to resolve each
    // subscription's plan in a sequential `await` inside the loop, N round
    // trips, uncached, for a subject who is usually holding two or three subs.
    const byPlan = await this.resolveForPlans(subs.map((s) => s.plan));
    const all: ResolvedEntitlement[] = [];
    for (const s of subs) {
      all.push(...applyOverrides(byPlan.get(s.planId) ?? [], s.entitlementOverrides));
    }
    // Free-tier fallback (#36): the Application's default plan applies on top of
    // what the subject's subscriptions grant, for feature gating without a $0
    // checkout. FEATURE only, CREDIT/LICENSE are stateful and need a real
    // sub. The org view never falls back to a per-user free tier.
    //
    // A BASE LAYER, not another voter in the merge below. That merge unions
    // across sources, booleans OR-true, numbers take the max, which is right
    // for two subscriptions a subject genuinely holds together, and wrong for a
    // default the subject has not bought. Pushed flat, the free tier could only
    // ever raise the answer, so an operator restricting one customer through
    // `entitlementOverrides` got a 200, a `changed: true`, and a
    // `subscription.entitlements_updated` webhook carrying the lower value,
    // while `GET /billing/entitlements` kept serving the higher one. The
    // revocation and the downgrade were both no-ops that reported success.
    //
    // `suppressesFreeTier` already drops the whole fallback for SUBSCRIPTION and
    // USAGE plans, so the reachable case is a subject holding only a CREDIT pack
    // or a licence. Keyed rather than all-or-nothing, so a default key the
    // subscription says nothing about still applies.
    if (!suppressesFreeTier(subs) && !opts?.organizationId) {
      const def = await loadDefaultPlan(applicationId);
      if (def) {
        // Keys an OVERRIDE answered, and that RESOLVE to something.
        //
        // Override, not plan row: see `overriddenKeys`. Resolves, not merely
        // appears: the merge below drops a row whose value fails
        // `parseFeatureValue`, and the ADD path does not type check a key the
        // plan lacks, so a STRING override can later meet an INT plan row.
        // Counting that as answered withheld the default and made the key
        // vanish from `features` entirely, which is worse than either value.
        // The empty string is excluded for the same reason: it parses, so it is
        // not null, but every `if (features.x)` gate reads it as absent, and
        // the plan-level `validate` refuses `''`, so it is a value only an
        // override can introduce.
        // Per subscription, for the same reason as the meter above: one
        // subscription's override must not withhold the default for a key only
        // a different subscription's plan row supplies.
        const overridden = new Set<string>();
        for (const sub of subs) {
          const rows = applyOverrides(byPlan.get(sub.planId) ?? [], sub.entitlementOverrides);
          const here = overriddenKeys([sub]);
          for (const e of rows) if (here.has(`${e.kind}:${e.key}`)) overridden.add(`${e.kind}:${e.key}`);
        }
        const answered = new Set(
          all
            .filter(
              (e) =>
                e.kind === 'FEATURE' &&
                overridden.has(`FEATURE:${e.key}`) &&
                parseFeatureValue(e.valueType, e.value) !== null &&
                e.value !== '',
            )
            .map((e) => e.key),
        );
        // UNSHIFTED, not pushed. The merge below is last-wins for STRING, so a
        // default appended last did not fill a gap, it OVERWROTE: an
        // Application whose free tier said `support_tier: "community"`
        // downgraded a paying subscriber whose plan said `"priority"`. Numbers
        // and booleans are order-independent (max, OR-true), so putting the
        // default first costs them nothing and makes "base layer" true for
        // every value type rather than only two of the three.
        all.unshift(
          ...(await this.resolveForPlan(def)).filter(
            (e) => e.kind === 'FEATURE' && !answered.has(e.key),
          ),
        );
      }
    }
    const features: Record<string, boolean | number | string> = {};
    for (const e of all) {
      if (e.kind !== 'FEATURE') continue;
      const v = parseFeatureValue(e.valueType, e.value);
      // An empty string is not a value. It parses, so it is not null, but every
      // `if (features.x)` gate reads it as absent, and the plan-level validator
      // refuses it, so only an override can introduce one, and letting it win
      // the last-wins tie would blank a feature the subject is entitled to.
      // Skipped here rather than relied on through ordering: it is excluded from
      // `answered` for the same reason, and the two have to agree.
      if (v === null || v === '') continue;
      const prev = features[e.key];
      if (typeof v === 'boolean') features[e.key] = prev === true || v;
      else if (typeof v === 'number') features[e.key] = Math.max(typeof prev === 'number' ? prev : -Infinity, v);
      else features[e.key] = v;
    }
    return { features, entitlements: all, subject };
  },

  /** Operator/org view of an org's entitlements + shared credit pool. */
  async resolveForOrg(
    applicationId: string,
    organizationId: string,
  ): Promise<{
    features: Record<string, boolean | number | string>;
    entitlements: ResolvedEntitlement[];
    creditBalance: number;
  }> {
    return this.resolveForEndUser(applicationId, '', { organizationId });
  },

  /**
   * Included usage quota a *subject's own pool* holds for a meter, summed over
   * its ACTIVE subscriptions. Returns `null` when the subject has no USAGE
   * entitlement with an included quantity for the meter → **uncapped** (legacy
   * metered plans, or no plan at all). Used by usage.record for the hard cap.
   *
   * Pooling (ORG_BILLING §3): a sub with `beneficiaryOrgId` set pools its usage
   * allowance to the org; a sub with none pools to the owner end-user. So the
   * org subject reads org-beneficiary subs, and the end-user subject reads only
   * its own *personal* subs (no `beneficiaryOrgId`), org usage is metered under
   * the org subject, never doubled onto a member's personal pool.
   */
  async includedQuotaFor(
    applicationId: string,
    subject: { endUserId?: string | undefined; organizationId?: string | undefined },
    meterSlug: string,
  ): Promise<{ included: number; creditsPerUnit: number | null } | null> {
    const quotas = await this.includedQuotasFor(applicationId, subject, [meterSlug]);
    return quotas.get(meterSlug) ?? null;
  },

  /**
   * `includedQuotaFor` for several meters at once. The subject's
   * subscriptions, their plans and the free-tier default plan are loaded ONCE;
   * each meter is then computed from them by the same per-meter rule.
   * `includedQuotaFor` is this with one slug, so the record path and a
   * multi-meter read cannot disagree. Every requested slug is in the map
   * (null: uncapped).
   */
  async includedQuotasFor(
    applicationId: string,
    subject: { endUserId?: string | undefined; organizationId?: string | undefined },
    meterSlugs: readonly string[],
  ): Promise<Map<string, { included: number; creditsPerUnit: number | null } | null>> {
    // Same ENTITLING_STATUSES as resolveForEndUser, and for the same reason
    // read the other way round: dropping a dunning customer's subscription
    // here does not cap them harder, it makes them UNMETERED (no USAGE
    // entitlement found → null → uncapped). Neither losing the quota they
    // bought nor being handed unlimited consumption is the right answer to a
    // card that has not been retried to exhaustion yet.
    const where: Prisma.SubscriptionWhereInput = subject.organizationId
      ? {
          applicationId,
          beneficiaryOrgId: subject.organizationId,
          // `stillEntitling`, not a bare status filter. The personal branch
          // below has always excluded a lapsed subscription; the org branch
          // did not, so an organization whose subscription ended kept its
          // included quota indefinitely. Harmless while a quota only capped;
          // once usage past it is charged, it is free consumption.
          ...stillEntitling(new Date()),
        }
      : {
          applicationId,
          endUserId: subject.endUserId!,
          beneficiaryOrgId: null,
          ...stillEntitling(new Date()),
        };
    const subs = await prisma.subscription.findMany({ where, include: { plan: true } });
    // One query for every plan, same reason as resolveForEndUser: this runs on
    // the usage.record hot path, once per recorded event.
    const byPlan = await this.resolveForPlans(subs.map((s) => s.plan));
    // The free-tier default applies only to a personal subject whose
    // subscriptions do not suppress it; loaded once for every meter.
    const defaultPlan =
      !suppressesFreeTier(subs) && !subject.organizationId ? await loadDefaultPlan(applicationId) : null;
    const defaultEntitlements = defaultPlan ? await this.resolveForPlan(defaultPlan) : null;

    const quotaFor = (meterSlug: string): { included: number; creditsPerUnit: number | null } | null => {
      let total = 0;
      let capped = false;
      // The cheapest rate across the plans that price this meter. Lowest, not
      // first or highest: quota is additive, so a subscriber holding two plans
      // already gets the benefit of both, and charging them the dearer rate
      // while summing the allowances would be inconsistent. Written down here
      // because the code cannot decide it and two engineers would not agree.
      let rate: number | null = null;
      const consider = (e: { kind: string; key: string; quantity: number | null; creditsPerUnit?: number | null }): void => {
        if (e.kind !== 'USAGE' || e.key !== meterSlug) return;
        if (e.quantity != null && e.quantity > 0) {
          total += e.quantity;
          capped = true;
        }
        // A priced entitlement caps too, even at quantity 0, that is how an
        // operator says "no free units, charge from the first one".
        if (e.creditsPerUnit != null) {
          capped = true;
          rate = rate === null ? e.creditsPerUnit : Math.min(rate, e.creditsPerUnit);
        }
      };
      // Decided PER SUBSCRIPTION, not unioned across them. Both conjuncts have to
      // hold for the SAME subscription, or one subscription's override could
      // withhold the default for a meter a different subscription's plan row
      // supplies, reachable by overriding on plan A, then removing that row from
      // plan A while plan B still carries the meter.
      let meterOverridden = false;
      for (const s of subs) {
        const ents = applyOverrides(byPlan.get(s.planId) ?? [], s.entitlementOverrides);
        let rowPresent = false;
        for (const e of ents) {
          if (e.kind === 'USAGE' && e.key === meterSlug) rowPresent = true;
          consider(e);
        }
        if (rowPresent && overriddenKeys([s]).has(`USAGE:${meterSlug}`)) meterOverridden = true;
      }
      // An override is authoritative for this meter only if it actually LANDED.
      //
      // Both halves are load-bearing. The key has to be named, or a plan row would
      // withhold the default and a credit pack would strip a free tier. And a row
      // has to exist, because `applyOverrides` never ADDs a non-FEATURE row: an
      // override naming a meter the plan does not carry is dropped by the resolver
      // and means nothing, so it must not cap. Reading override keys alone made
      // `{"USAGE:api_calls": 1000}` on a plan with no such entitlement report a
      // cap of zero instead of "unmetered", which an existing test caught.
      //
  // A legal `0` override always sits on a PRICED row, because `validate`
      // refuses a zero quantity without a price, so `consider` has already capped
      // it. Nothing extra is needed to make zero mean zero.
      // Free-tier fallback (#36): a personal subject honours the default plan's
      // included USAGE quota for this meter, so a free tier can cap consumption
      // without a $0 subscription. Org subjects don't fall back.
      //
      // Two things are decided separately here, because they fail in opposite
      // directions.
      //
      // QUANTITY is withheld only when an OVERRIDE spoke about this meter. The
      // accumulation above is additive, so a default of 1,000 did not lose to an
      // override of 50, it was added to it, and an operator lowering an allowance
      // raised it. But the same additivity is CORRECT against a plan row: buying a
      // credit pack that happens to mention the meter is a top-up, not a plan, and
      // silently halving a subscriber's quota for topping up is the bug this
      // fallback exists to avoid (`suppressesFreeTier`, and the credit-purchase
      // test). So the override wins and the plan row does not.
      //
      // An override that landed CAPS, including at zero. A legal zero sits on a
      // priced row `consider` has already capped; this covers the drift pair
      // (quantity 0, no price), where nothing else does. Without it, a subject the
      // operator explicitly restricted resolves `null`, unmetered and unbilled,
      // whenever the Application has no default plan, which is the common case.
      if (meterOverridden) capped = true;

      // PRICE is never withheld. `rate` is a minimum across everything that prices
      // the meter, and it is what `usage.record` charges. Dropping the default
      // from that minimum does not change an allowance, it silently RAISES what a
      // subscriber pays per unit -- a customer on a plan priced at 4 would start
      // paying 4 where the free tier's 1 used to floor them. A change about who
      // gets how many units must not move a price, so the default's rate is
      // always considered even when its quantity is not.
      for (const e of defaultEntitlements ?? []) {
        if (e.kind !== 'USAGE' || e.key !== meterSlug) continue;
        if (e.creditsPerUnit != null) {
          capped = true;
          rate = rate === null ? e.creditsPerUnit : Math.min(rate, e.creditsPerUnit);
        }
        if (!meterOverridden && e.quantity != null && e.quantity > 0) {
          total += e.quantity;
          capped = true;
        }
      }
      return capped ? { included: total, creditsPerUnit: rate } : null;
    };
    return new Map(meterSlugs.map((slug) => [slug, quotaFor(slug)]));
  },
};

/** Single synthesized entitlement from a legacy single-`kind` plan. */
function synthesizeLegacy(plan: Plan): ResolvedEntitlement[] {
  switch (plan.kind) {
    case 'CREDIT':
      return plan.creditsAmount && plan.creditsAmount > 0
        ? [{ kind: 'CREDIT', key: '', valueType: null, value: null, quantity: plan.creditsAmount, creditsPerUnit: null, licenseKind: null, rollover: false }]
        : [];
    case 'LICENSE':
      return plan.licenseKind
        ? [{ kind: 'LICENSE', key: '', valueType: null, value: null, quantity: plan.licenseSeatsAllowed ?? null, creditsPerUnit: null, licenseKind: plan.licenseKind, rollover: false }]
        : [];
    case 'USAGE':
      return plan.meterSlug
        ? [{ kind: 'USAGE', key: plan.meterSlug, valueType: null, value: null, quantity: null, creditsPerUnit: null, licenseKind: null, rollover: false }]
        : [];
    case 'SUBSCRIPTION':
    default:
      return []; // pure recurring access; no materialized grant
  }
}

/**
 * Infer the `valueType` of a FEATURE override the plan has no row for.
 *
 * Only needed when an override ADDS an entitlement (see below): an override
 * that lands on an existing row inherits that row's declared type. The
 * ordering matters, `"true"` must not be read as a string, and `"50"` must
 * not be read as a string either, because `parseFeatureValue` is what every
 * consumer reads through and a mistyped INT resolves to a string the caller
 * cannot compare.
 */
function inferFeatureValueType(value: string): EntitlementValueType {
  if (value === 'true' || value === 'false') return 'BOOL';
  return Number.isInteger(Number(value)) && value.trim() !== '' ? 'INT' : 'STRING';
}

/**
 * Apply a subscription's sparse overrides over the plan's entitlements. Keys
 * are "KIND:key" → for FEATURE the override is the value, for the stateful
 * kinds it's the quantity.
 *
 * ## A FEATURE override may ADD a row the plan does not carry
 *
 * It could not, and that quietly made the documented remedy for a hit
 * allowance a no-op: `entitlementOverrides` is how a bespoke deal is sold
 * without minting a private plan, but a plan that carries no
 * `FEATURE:max_workspaces` row had nothing to override, so setting one
 * changed nothing at all and the customer stayed capped. "Only overrides what
 * already exists" also makes the mechanism useless for exactly the case it
 * exists for, the plan the operator is trying to deviate from is by
 * definition the one that does not describe this customer.
 *
 * ADD is FEATURE-only on purpose. A CREDIT, LICENSE or USAGE entitlement is
 * MATERIALIZED by `provision`, it grants credits, issues a licence key, sets
 * a seat count, and the override value is a bare number, so inventing one
 * would mean inventing a `licenseKind` and a `rollover` policy too and then
 * handing out whatever they turned out to mean. A FEATURE is resolved at read
 * time and materializes nothing, so an added one can only ever answer a
 * question. Adding a stateful kind stays a plan-level decision.
 */
export function applyOverrides(
  base: ResolvedEntitlement[],
  overridesJson: unknown,
): ResolvedEntitlement[] {
  if (!overridesJson || typeof overridesJson !== 'object') return base;
  const overrides = overridesJson as Record<string, unknown>;
  const applied = base.map((e) => {
    const o = overrides[`${e.kind}:${e.key}`];
    if (o === undefined) return e;
    if (e.kind === 'FEATURE') return { ...e, value: String(o) };
    const q = Number(o);
    return Number.isFinite(q) ? { ...e, quantity: q } : e;
  });

  const present = new Set(base.map((e) => `${e.kind}:${e.key}`));
  for (const [key, value] of Object.entries(overrides)) {
    if (present.has(key) || !key.startsWith('FEATURE:')) continue;
    const featureKey = key.slice('FEATURE:'.length);
    if (!featureKey || value === null || value === undefined) continue;
    const asString = String(value);
    applied.push({
      kind: 'FEATURE',
      key: featureKey,
      valueType: inferFeatureValueType(asString),
      value: asString,
      quantity: null,
      creditsPerUnit: null,
      licenseKind: null,
      rollover: false,
    });
  }
  return applied;
}
