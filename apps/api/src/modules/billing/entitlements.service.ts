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
} from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { BillingConfigSchema } from '@relipay/shared-types';
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

export interface ResolvedEntitlement {
  kind: PlanEntitlementKind;
  key: string;
  valueType: EntitlementValueType | null;
  value: string | null;
  quantity: number | null;
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

function shape(e: PlanEntitlement): ResolvedEntitlement {
  return {
    kind: e.kind,
    key: e.key,
    valueType: e.valueType,
    value: e.value,
    quantity: e.quantity,
    licenseKind: e.licenseKind,
    rollover: e.rollover,
  };
}

export const entitlementsService = {
  /** List a plan's explicit entitlement rows. */
  async listForPlan(planId: string): Promise<PlanEntitlement[]> {
    return prisma.planEntitlement.findMany({
      where: { planId },
      orderBy: [{ kind: 'asc' }, { key: 'asc' }],
    });
  },

  /** Create or update one entitlement on a plan (keyed by (plan, kind, key)). */
  async upsert(args: {
    planId: string;
    kind: PlanEntitlementKind;
    key?: string;
    valueType?: EntitlementValueType | null;
    value?: string | null;
    quantity?: number | null;
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
        licenseKind: args.licenseKind ?? null,
        rollover: args.rollover ?? false,
        ...(args.metadata !== undefined && { metadata: args.metadata as never }),
      },
      update: {
        valueType: args.valueType ?? null,
        value: args.value ?? null,
        quantity: args.quantity ?? null,
        licenseKind: args.licenseKind ?? null,
        rollover: args.rollover ?? false,
        ...(args.metadata !== undefined && { metadata: args.metadata as never }),
      },
    });
  },

  async remove(planId: string, id: string): Promise<{ removed: boolean }> {
    const row = await prisma.planEntitlement.findUnique({ where: { id } });
    if (!row || row.planId !== planId) {
      throw new RelipayError({
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
    licenseKind?: LicenseKind | null;
  }): void {
    const bad = (message: string, fix: string): never => {
      throw new RelipayError({ statusCode: 400, code: 'PLAN_ENTITLEMENT_INVALID', message, fix });
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
        if (!args.quantity || args.quantity <= 0)
          bad('USAGE entitlement needs a positive `quantity` (included units).', 'Set the included quota.');
        break;
    }
  },

  /**
   * The effective entitlements for a plan: its explicit rows, or — when it has
   * none — a single synthesized entitlement from the legacy `kind` fields.
   */
  async resolveForPlan(plan: Plan): Promise<ResolvedEntitlement[]> {
    const rows = await this.listForPlan(plan.id);
    if (rows.length > 0) return rows.map(shape);
    return synthesizeLegacy(plan);
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
   * Resolve the entitlements a subject currently holds across ACTIVE subs.
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
        where: { applicationId, beneficiaryOrgId: opts.organizationId, status: 'ACTIVE' },
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
          status: 'ACTIVE',
          OR: [{ endUserId }, ...(orgIds.length > 0 ? [{ beneficiaryOrgId: { in: orgIds } }] : [])],
        },
        include: { plan: true },
      });
      subject = { endUserId };
    }

    const all: ResolvedEntitlement[] = [];
    for (const s of subs) {
      const resolved = applyOverrides(await this.resolveForPlan(s.plan), s.entitlementOverrides);
      all.push(...resolved);
    }
    // Free-tier fallback (#36): an end-user with no active subscription gets the
    // Application's default plan's FEATURE entitlements (feature gating without a
    // $0 checkout). FEATURE only — CREDIT/LICENSE are stateful and need a real
    // sub. The org view never falls back to a per-user free tier.
    if (subs.length === 0 && !opts?.organizationId) {
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
  ): Promise<number | null> {
    const where: Prisma.SubscriptionWhereInput = subject.organizationId
      ? { applicationId, beneficiaryOrgId: subject.organizationId, status: 'ACTIVE' }
      : { applicationId, endUserId: subject.endUserId!, beneficiaryOrgId: null, status: 'ACTIVE' };
    const subs = await prisma.subscription.findMany({ where, include: { plan: true } });
    let total = 0;
    let capped = false;
    for (const s of subs) {
      const ents = applyOverrides(await this.resolveForPlan(s.plan), s.entitlementOverrides);
      for (const e of ents) {
        if (e.kind === 'USAGE' && e.key === meterSlug && e.quantity != null && e.quantity > 0) {
          total += e.quantity;
          capped = true;
        }
      }
    }
    // Free-tier fallback (#36): a personal subject with no active sub honours the
    // default plan's included USAGE quota for this meter, so a free tier can cap
    // consumption without a $0 subscription. Org subjects don't fall back.
    if (subs.length === 0 && !subject.organizationId) {
      const def = await loadDefaultPlan(applicationId);
      if (def) {
        for (const e of await this.resolveForPlan(def)) {
          if (e.kind === 'USAGE' && e.key === meterSlug && e.quantity != null && e.quantity > 0) {
            total += e.quantity;
            capped = true;
          }
        }
      }
    }
    return capped ? total : null;
  },
};

/** Single synthesized entitlement from a legacy single-`kind` plan. */
function synthesizeLegacy(plan: Plan): ResolvedEntitlement[] {
  switch (plan.kind) {
    case 'CREDIT':
      return plan.creditsAmount && plan.creditsAmount > 0
        ? [{ kind: 'CREDIT', key: '', valueType: null, value: null, quantity: plan.creditsAmount, licenseKind: null, rollover: false }]
        : [];
    case 'LICENSE':
      return plan.licenseKind
        ? [{ kind: 'LICENSE', key: '', valueType: null, value: null, quantity: plan.licenseSeatsAllowed ?? null, licenseKind: plan.licenseKind, rollover: false }]
        : [];
    case 'USAGE':
      return plan.meterSlug
        ? [{ kind: 'USAGE', key: plan.meterSlug, valueType: null, value: null, quantity: null, licenseKind: null, rollover: false }]
        : [];
    case 'SUBSCRIPTION':
    default:
      return []; // pure recurring access; no materialized grant
  }
}

/**
 * Apply a subscription's sparse overrides over the plan's entitlements. Keys
 * are "KIND:key" → for FEATURE the override is the value, for the stateful
 * kinds it's the quantity. Only existing entitlements are overridden (no add).
 */
function applyOverrides(
  base: ResolvedEntitlement[],
  overridesJson: unknown,
): ResolvedEntitlement[] {
  if (!overridesJson || typeof overridesJson !== 'object') return base;
  const overrides = overridesJson as Record<string, unknown>;
  return base.map((e) => {
    const o = overrides[`${e.kind}:${e.key}`];
    if (o === undefined) return e;
    if (e.kind === 'FEATURE') return { ...e, value: String(o) };
    const q = Number(o);
    return Number.isFinite(q) ? { ...e, quantity: q } : e;
  });
}
