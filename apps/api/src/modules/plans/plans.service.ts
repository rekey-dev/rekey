/**
 * Plans service.
 *
 * Plans are admin-managed (Panel → Application → Plans, or `relipay plans
 * create` CLI). They are *not* end-user-mutable. Each Application owns its
 * own plan catalogue; slugs are unique per-Application.
 *
 * On create we also call the Application's BillingProvider to register the
 * plan upstream (Stripe → Product+Price; PayPal → Plan; etc.) and stash
 * the returned id back into `Plan.metadata` for reconciliation.
 */

import type { Plan, PlanInterval, PlanKind, LicenseKind, Application } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { applicationsService } from '../applications/applications.service.js';
import { getProviderForApplication } from '../billing/providers/index.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

export interface CreatePlanInput {
  applicationId: string;
  slug: string;
  name: string;
  amount: number;        // smallest currency unit
  currency?: string;     // ISO 4217
  interval?: PlanInterval;
  kind?: PlanKind;
  // LICENSE-kind config — required when kind = LICENSE.
  licenseKind?: LicenseKind;
  licenseSeatsAllowed?: number;
  licenseDurationDays?: number;
  // USAGE-kind config — required when kind = USAGE.
  meterSlug?: string;
  pricePerUnitCents?: number;
  // CREDIT-kind config — required when kind = CREDIT.
  creditsAmount?: number;
  metadata?: Record<string, unknown>;
}

export const plansService = {
  async listForApplication(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<Plan[]> {
    return prisma.plan.findMany({
      where: { applicationId, ...(includeInactive ? {} : { active: true }) },
      orderBy: [{ interval: 'asc' }, { amount: 'asc' }],
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  async getBySlug(applicationId: string, slug: string): Promise<Plan> {
    const plan = await prisma.plan.findUnique({
      where: { applicationId_slug: { applicationId, slug } },
    });
    if (!plan) {
      throw new RelipayError({
        statusCode: 404,
        code: 'PLAN_NOT_FOUND',
        message: `Plan "${slug}" not found in application "${applicationId}".`,
        fix: 'List available plans with GET /api/v1/admin/applications/:id/plans, or create one with POST.',
      });
    }
    return plan;
  },

  async create(input: CreatePlanInput): Promise<Plan> {
    if (!SLUG_RE.test(input.slug)) {
      throw new RelipayError({
        statusCode: 400,
        code: 'PLAN_SLUG_INVALID',
        message: `Plan slug "${input.slug}" is not URL-safe.`,
        fix: 'Use lowercase letters, digits, underscores, and hyphens. Must start and end with alphanumerics. Max 40 chars.',
      });
    }
    if (input.amount < 0) {
      throw new RelipayError({
        statusCode: 400,
        code: 'PLAN_AMOUNT_INVALID',
        message: 'Plan amount must be >= 0 (smallest currency unit, e.g. cents).',
        fix: 'Send the price in cents (or paise/sen/etc.) — never as a decimal float.',
      });
    }

    const kind: PlanKind = input.kind ?? 'SUBSCRIPTION';

    // Per-kind validation. Each kind requires its own bundle of fields;
    // surfacing the gap here prevents broken plans from being checked out.
    if (kind === 'LICENSE') {
      if (!input.licenseKind) {
        throw new RelipayError({
          statusCode: 400,
          code: 'PLAN_LICENSE_KIND_REQUIRED',
          message: 'LICENSE-kind plans need `licenseKind` (PERPETUAL / TIMED / SEATS).',
          fix: 'Pick a license kind in the plan editor.',
        });
      }
      if (input.licenseKind === 'TIMED' && !input.licenseDurationDays) {
        throw new RelipayError({
          statusCode: 400,
          code: 'PLAN_LICENSE_DURATION_REQUIRED',
          message: 'TIMED licenses need a duration in days.',
          fix: 'Set `licenseDurationDays` (e.g. 365 for one year).',
        });
      }
      if (input.licenseKind === 'SEATS' && !input.licenseSeatsAllowed) {
        throw new RelipayError({
          statusCode: 400,
          code: 'PLAN_LICENSE_SEATS_REQUIRED',
          message: 'SEATS licenses need a seat count.',
          fix: 'Set `licenseSeatsAllowed` (e.g. 5 for a 5-seat pack).',
        });
      }
    }
    if (kind === 'USAGE') {
      if (!input.meterSlug || input.pricePerUnitCents === undefined) {
        throw new RelipayError({
          statusCode: 400,
          code: 'PLAN_USAGE_CONFIG_REQUIRED',
          message: 'USAGE-kind plans need `meterSlug` + `pricePerUnitCents`.',
          fix: 'Bind to an existing usage meter and set the per-unit price (in cents).',
        });
      }
      // Validate the meter exists in the same Application's catalogue.
      const meter = await prisma.usageMeter.findUnique({
        where: { applicationId_slug: { applicationId: input.applicationId, slug: input.meterSlug } },
      });
      if (!meter) {
        throw new RelipayError({
          statusCode: 400,
          code: 'PLAN_USAGE_METER_UNKNOWN',
          message: `Meter "${input.meterSlug}" not found in this Application.`,
          fix: 'Create the meter first on the Usage tab.',
        });
      }
    }
    if (kind === 'CREDIT') {
      if (input.creditsAmount === undefined || input.creditsAmount <= 0) {
        throw new RelipayError({
          statusCode: 400,
          code: 'PLAN_CREDITS_AMOUNT_REQUIRED',
          message: 'CREDIT-kind plans need a positive `creditsAmount` (credits granted per purchase).',
          fix: 'Set how many credits this pack grants, e.g. 100.',
        });
      }
    }

    const application: Application = await applicationsService.get(input.applicationId);

    let plan: Plan;
    try {
      plan = await prisma.plan.create({
        data: {
          applicationId: input.applicationId,
          slug: input.slug,
          name: input.name,
          amount: input.amount,
          currency: input.currency ?? 'USD',
          interval: input.interval ?? 'MONTH',
          kind,
          ...(input.licenseKind !== undefined && { licenseKind: input.licenseKind }),
          ...(input.licenseSeatsAllowed !== undefined && { licenseSeatsAllowed: input.licenseSeatsAllowed }),
          ...(input.licenseDurationDays !== undefined && { licenseDurationDays: input.licenseDurationDays }),
          ...(input.meterSlug !== undefined && { meterSlug: input.meterSlug }),
          ...(input.pricePerUnitCents !== undefined && { pricePerUnitCents: input.pricePerUnitCents }),
          ...(input.creditsAmount !== undefined && { creditsAmount: input.creditsAmount }),
          metadata: (input.metadata ?? {}) as never,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RelipayError({
          statusCode: 409,
          code: 'PLAN_SLUG_TAKEN',
          message: `A plan with slug "${input.slug}" already exists in this application.`,
          fix: 'Pick a different slug or update the existing plan.',
        });
      }
      throw e;
    }

    // Register the plan upstream and persist the provider id back into metadata.
    // We do this *after* the local insert so a provider failure doesn't leave
    // half-state — the plan exists locally but is `active = true` only after
    // registration succeeds. (For the stub today this always succeeds; for
    // real Stripe it could fail and we'd need to handle that.)
    // Eagerly register against Stripe (the legacy single-provider default).
    // Other providers register lazily on first checkout — `Plan.metadata`
    // gains keys for each provider as they're used. Eager fan-out across
    // every configured provider is a future optimization; lazy is fine
    // because the provider stub is idempotent.
    const provider = await getProviderForApplication(application, 'stripe');
    const providerRef = await provider.ensurePlanRegistered(plan);
    return prisma.plan.update({
      where: { id: plan.id },
      data: {
        metadata: {
          ...(plan.metadata as object),
          stripe: { priceId: providerRef.providerPlanId },
        } as never,
      },
    });
  },

  async setActive(applicationId: string, slug: string, active: boolean): Promise<Plan> {
    const plan = await this.getBySlug(applicationId, slug);
    return prisma.plan.update({ where: { id: plan.id }, data: { active } });
  },

  /**
   * Edit a plan's ENTITLEMENTS in place — the things it grants, which live
   * entirely on the ReliPay side and don't touch the provider-registered Price:
   * display name, LICENSE seats/duration, CREDIT amount, and free-form metadata
   * (feature flags etc.).
   *
   * Price fields (`amount`, `currency`, `interval`, `pricePerUnitCents`) are
   * DELIBERATELY not editable: a Stripe Price (and its PayPal/Razorpay analogs)
   * is immutable once created, so changing the price means archiving this plan
   * (`setActive(false)`) and creating a replacement. This method never
   * re-registers with the provider.
   *
   * Metadata is shallow-MERGED, and the provider-reserved keys
   * (`stripe`/`paypal`/`razorpay`) are stripped from the incoming patch so an
   * entitlement edit can never clobber the stored provider price/product ids.
   */
  async updateEntitlements(
    applicationId: string,
    slug: string,
    patch: {
      name?: string;
      licenseSeatsAllowed?: number | null;
      licenseDurationDays?: number | null;
      creditsAmount?: number | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Plan> {
    const plan = await this.getBySlug(applicationId, slug);

    let metadata: Record<string, unknown> | undefined;
    if (patch.metadata !== undefined) {
      const incoming = { ...patch.metadata };
      for (const reserved of ['stripe', 'paypal', 'razorpay']) delete incoming[reserved];
      const current = (plan.metadata ?? {}) as Record<string, unknown>;
      metadata = { ...current, ...incoming };
    }

    return prisma.plan.update({
      where: { id: plan.id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.licenseSeatsAllowed !== undefined && {
          licenseSeatsAllowed: patch.licenseSeatsAllowed,
        }),
        ...(patch.licenseDurationDays !== undefined && {
          licenseDurationDays: patch.licenseDurationDays,
        }),
        ...(patch.creditsAmount !== undefined && { creditsAmount: patch.creditsAmount }),
        ...(metadata !== undefined && { metadata: metadata as object }),
      },
    });
  },
};
