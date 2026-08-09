/**
 * Plan entitlements — the bundle of benefits a plan grants.
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
 * Subject = the subscription's owner end-user, or — when the sub names a
 * `beneficiaryOrgId` — the org pool (owner+beneficiary, ORG_BILLING.md).
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
import { RekeyError } from '../../lib/error.js';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { creditsService } from '../credits/credits.service.js';
import { licensesService } from '../licenses/licenses.service.js';

/**
 * Free-tier fallback (#36): the Application's `billingConfig.defaultPlanSlug`
 * plan, applied at read time to end-users with no active subscription. Returns
 * the active plan or null when no default is configured / the slug is stale.
 * Read-only — only FEATURE flags + included USAGE quota are honoured by callers
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
 * window, not the end of the subscription — the provider is still retrying,
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
const ENTITLING_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'PAST_DUE'];

/**
 * The `where` fragment that defines "currently entitling".
 *
 * Status alone is not enough. A subscription scheduled to cancel at the end of
 * its period stays ACTIVE until something terminates it — the provider's
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
 * the portal read to settle the row's status and emit the event — this makes
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
 * instead — `applySubscriptionStatusMirror` deliberately declines to let
 * PayPal's own CANCELLED event shorten it. No further event is coming, so under
 * the carve-out the lapsed row went on granting everything the buyer had
 * cancelled, indefinitely, until an unrelated portal read happened to run
 * `expireIfDue`. That is the exact defect this filter was written to fix,
 * wearing a provider id.
 *
 * The precondition that makes it safe is the same either way: `cancelAt` on a
 * provider-backed row is only ever written after the provider CONFIRMED the
 * cancellation — `cancelSubscription` throws on failure and the row is left
 * untouched — or mirrored from the provider's own schedule. A date in the past
 * therefore means the provider has agreed.
 */
function stillEntitling(now: Date) {
  return {
    status: { in: ENTITLING_STATUSES },
    AND: [
      { OR: [{ cancelAt: null }, { cancelAt: { gt: now } }] },
      // A term that has elapsed stops entitling — but only where the term is
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
  /** USAGE only — credits per unit past `quantity`. Null = hard cap. */
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
 * Only a recurring plan does. A one-off purchase — a credit pack, a licence —
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
    /** USAGE only — credits per unit past `quantity`. Null/absent = hard cap. */
    creditsPerUnit?: number | null;
    licenseKind?: LicenseKind | null;
    rollover?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<PlanEntitlement> {
    const key = args.key ?? '';
    this.validate({ ...args, key });
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
        // it says nothing at all — an entitlement granting no units and
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
   * The effective entitlements for a plan: its explicit rows, or — when it has
   * none — a single synthesized entitlement from the legacy `kind` fields.
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
   * The plan-level view (`resolveForPlan`) is not what a subscriber holds —
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
   * Idempotent per (subscription, period) — safe under webhook replay + renewal.
   *
   * `firstPeriod`: anchor this grant to the subscription's FIRST period
   * (`'initial'`) regardless of `currentPeriodEnd`. The first period is
   * provisioned twice — once at `checkout.session.completed` (when
   * `currentPeriodEnd` is still null) and once at the first `invoice.paid`
   * (`billing_reason: subscription_create`). Stripe does NOT order webhooks, so
   * `customer.subscription.updated` can set `currentPeriodEnd` BEFORE that first
   * invoice arrives — if it does, the invoice would otherwise anchor on the new
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
  }): Promise<void> {
    const sub = args.subscription;
    const [plan, application, endUser] = await Promise.all([
      prisma.plan.findUniqueOrThrow({ where: { id: sub.planId } }),
      prisma.application.findUniqueOrThrow({ where: { id: sub.applicationId } }),
      prisma.endUser.findUniqueOrThrow({ where: { id: sub.endUserId } }),
    ]);
    const entitlements = applyOverrides(await this.resolveForPlan(plan), sub.entitlementOverrides);
    const period = args.firstPeriod ? 'initial' : sub.currentPeriodEnd?.toISOString() ?? 'initial';
    // Beneficiary (ORG_BILLING.md): the org when the sub names one, else the
    // owner end-user. Credits + feature access flow to the beneficiary.
    const beneficiary = sub.beneficiaryOrgId
      ? { organizationId: sub.beneficiaryOrgId }
      : { endUserId: endUser.id };

    for (const e of entitlements) {
      if (e.kind === 'CREDIT' && e.quantity && e.quantity > 0) {
        await creditsService.grantFromPurchase({
          applicationId: application.id,
          ...beneficiary,
          amount: e.quantity,
          // Idempotency anchor: one grant per (subscription, period).
          paymentRef: `ent:${sub.id}:CREDIT:${period}`,
          metadata: { source: 'entitlement', planId: plan.id, subscriptionId: sub.id },
        });
      } else if (e.kind === 'LICENSE' && e.licenseKind) {
        // Owner+beneficiary (ORG_BILLING §3): an org-beneficiary sub issues ONE
        // license pooled to the org (its `seatsAllowed` seats are shared by the
        // team's machines); a personal sub issues to the owner end-user.
        // Idempotent per pool: at most one license per (app, pool, plan), so
        // renewal/webhook replay never over-issues.
        const existing = await prisma.license.findFirst({
          where: sub.beneficiaryOrgId
            ? { applicationId: application.id, organizationId: sub.beneficiaryOrgId, planId: plan.id }
            : { applicationId: application.id, endUserId: endUser.id, organizationId: null, planId: plan.id },
        });
        if (existing) {
          // A TIMED license must be EXTENDED on renewal — the buyer is charged
          // every period, so its term has to roll forward. Push `expiresAt` out
          // by the plan's duration from `max(currentExpiry, now)` (so a late
          // renewal leaves no gap, an early one stacks the term) and clear any
          // stale EXPIRED status. PERPETUAL/SEATS have no term to extend, so they
          // keep the idempotent skip.
          //
          // Idempotent per (subscription, period) — same anchor the CREDIT grant
          // uses — so a same-period replay (e.g. invoice.paid + the synonymous
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
          endUser, // owner/holder — always set
          planId: plan.id,
          kind: e.licenseKind,
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
   * Default (no `organizationId`): the **end-user view** — unions the user's
   * own subscriptions with subscriptions whose beneficiary is an org they
   * belong to (so members see team-granted features); credit balance is the
   * user's personal pool.
   *
   * With `organizationId`: the **org view** — only subs whose beneficiary is
   * that org; credit balance is the shared org pool. (Membership must be
   * checked by the caller/route.)
   *
   * Feature flags merge: booleans OR-true, numbers max, strings last-wins.
   *
   * PAST_DUE counts as entitling here — see ENTITLING_STATUSES.
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
      });
      subject = { endUserId };
    }

    // One query for every subscription's plan entitlements, then the
    // per-subscription overrides applied in memory. This is the endpoint
    // customer apps call on every page load, and it used to resolve each
    // subscription's plan in a sequential `await` inside the loop — N round
    // trips, uncached, for a subject who is usually holding two or three subs.
    const byPlan = await this.resolveForPlans(subs.map((s) => s.plan));
    const all: ResolvedEntitlement[] = [];
    for (const s of subs) {
      all.push(...applyOverrides(byPlan.get(s.planId) ?? [], s.entitlementOverrides));
    }
    // Free-tier fallback (#36): an end-user with no active subscription gets the
    // Application's default plan's FEATURE entitlements (feature gating without a
    // $0 checkout). FEATURE only — CREDIT/LICENSE are stateful and need a real
    // sub. The org view never falls back to a per-user free tier.
    if (!suppressesFreeTier(subs) && !opts?.organizationId) {
      const def = await loadDefaultPlan(applicationId);
      if (def) {
        all.push(...(await this.resolveForPlan(def)).filter((e) => e.kind === 'FEATURE'));
      }
    }
    const features: Record<string, boolean | number | string> = {};
    for (const e of all) {
      if (e.kind !== 'FEATURE') continue;
      const v = parseFeatureValue(e.valueType, e.value);
      if (v === null) continue;
      const prev = features[e.key];
      if (typeof v === 'boolean') features[e.key] = prev === true || v;
      else if (typeof v === 'number') features[e.key] = Math.max(typeof prev === 'number' ? prev : -Infinity, v);
      else features[e.key] = v;
    }
    const creditBalance = await creditsService.getBalance(applicationId, subject);
    return { features, entitlements: all, creditBalance };
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
   * its own *personal* subs (no `beneficiaryOrgId`) — org usage is metered under
   * the org subject, never doubled onto a member's personal pool.
   */
  async includedQuotaFor(
    applicationId: string,
    subject: { endUserId?: string | undefined; organizationId?: string | undefined },
    meterSlug: string,
  ): Promise<{ included: number; creditsPerUnit: number | null } | null> {
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
      // A priced entitlement caps too, even at quantity 0 — that is how an
      // operator says "no free units, charge from the first one".
      if (e.creditsPerUnit != null) {
        capped = true;
        rate = rate === null ? e.creditsPerUnit : Math.min(rate, e.creditsPerUnit);
      }
    };
    for (const s of subs) {
      const ents = applyOverrides(byPlan.get(s.planId) ?? [], s.entitlementOverrides);
      for (const e of ents) consider(e);
    }
    // Free-tier fallback (#36): a personal subject with no active sub honours the
    // default plan's included USAGE quota for this meter, so a free tier can cap
    // consumption without a $0 subscription. Org subjects don't fall back.
    if (!suppressesFreeTier(subs) && !subject.organizationId) {
      const def = await loadDefaultPlan(applicationId);
      if (def) {
        for (const e of await this.resolveForPlan(def)) consider(e);
      }
    }
    return capped ? { included: total, creditsPerUnit: rate } : null;
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
 * ordering matters — `"true"` must not be read as a string, and `"50"` must
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
 * exists for — the plan the operator is trying to deviate from is by
 * definition the one that does not describe this customer.
 *
 * ADD is FEATURE-only on purpose. A CREDIT, LICENSE or USAGE entitlement is
 * MATERIALIZED by `provision` — it grants credits, issues a licence key, sets
 * a seat count — and the override value is a bare number, so inventing one
 * would mean inventing a `licenseKind` and a `rollover` policy too and then
 * handing out whatever they turned out to mean. A FEATURE is resolved at read
 * time and materializes nothing, so an added one can only ever answer a
 * question. Adding a stateful kind stays a plan-level decision.
 */
function applyOverrides(
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
