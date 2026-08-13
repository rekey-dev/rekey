/**
 * Plans service.
 *
 * Plans are admin-managed (Panel → Application → Plans, or `rekey plans
 * create` CLI). They are *not* end-user-mutable. Each Application owns its
 * own plan catalogue; slugs are unique per-Application.
 *
 * On create we register the plan with **Stripe** (Product+Price) and stash the
 * price id in `Plan.metadata` for reconciliation — but only when Stripe
 * credentials already exist for the Application. PayPal and Razorpay register
 * lazily at first checkout instead. Making the call unconditional broke plan
 * creation outright for PayPal-only and Razorpay-only operators once the stub
 * providers were deleted; see the note on `create` below.
 *
 * ## A plan is never on sale before the provider can charge for it
 *
 * The provider call is a NETWORK call, so it cannot live inside a database
 * transaction — holding one open across a 10-second Stripe round-trip would
 * pin a connection and a row lock on every plan create. What replaces the
 * transaction is ordering: the row is inserted in an explicitly un-purchasable
 * state (`active: false`, `registrationStatus: PENDING`) and only promoted to
 * `REGISTERED` + `active` once the provider has answered. A refusal settles it
 * to `FAILED` and re-throws.
 *
 * This is write-ahead, not compensation, and the difference is the whole point.
 * The previous shape — insert active, then register — put the row on sale for
 * the length of the provider call and left it there forever if the call failed:
 * a plan that 500s at checkout, indistinguishable on the wire from a working
 * one. A compensating DELETE would shrink that window but not close it (a crash
 * between the provider refusal and the delete reopens it), and it would burn a
 * slug an operator's pricing page may already reference. Writing the safe state
 * first means every way this can be interrupted — refusal, timeout, process
 * death — leaves a plan nobody can buy, which is the failure worth having.
 */

import { Prisma, type Plan, type PlanInterval, type PlanKind, type LicenseKind, type Application } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { providerError } from '../../lib/provider-errors.js';
import { applicationsService } from '../applications/applications.service.js';
import { credentialsNotConfigured, getProviderForApplication } from '../billing/providers/index.js';
import { billingCredentialsService } from '../billing/credentials.service.js';
import { planNotRegisteredError } from './plan-registration.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

/**
 * Metadata keys that hold PROVIDER-owned ids. Never operator-writable: an
 * entitlement edit that clobbered `metadata.stripe.priceId` would strand a live
 * Price, and a plan that could name any price id would be a way to charge for
 * somebody else's product.
 */
const PROVIDER_METADATA_KEYS = ['stripe', 'paypal', 'razorpay'] as const;

/** How much of a provider's refusal we keep on the row. */
const REGISTRATION_ERROR_MAX = 500;

/**
 * True once ANY provider has minted a price/plan object for this row.
 *
 * This is the gate on editing price fields. A Stripe Price — and its PayPal and
 * Razorpay analogues — is immutable once created, so an `amount` change on a
 * registered plan would make our row disagree with what the buyer is actually
 * charged. Before registration there is no such object to disagree with, which
 * is exactly why a plan that FAILED registration may still be re-priced.
 */
export function hasProviderRegistration(plan: Pick<Plan, 'metadata'>): boolean {
  const meta = (plan.metadata ?? {}) as Record<string, unknown>;
  return PROVIDER_METADATA_KEYS.some((key) => {
    const entry = meta[key];
    return typeof entry === 'object' && entry !== null && Object.keys(entry).length > 0;
  });
}

/**
 * Shallow-merge an operator's metadata patch over what's stored, dropping the
 * provider-reserved keys from the incoming side. Shared by every writer so the
 * stripping can't be forgotten in one of them.
 */
function mergeMetadata(plan: Plan, incoming: Record<string, unknown>): Record<string, unknown> {
  const patch = { ...incoming };
  for (const reserved of PROVIDER_METADATA_KEYS) delete patch[reserved];
  return { ...((plan.metadata ?? {}) as Record<string, unknown>), ...patch };
}

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

/** The filter `listForApplication` and `countForApplication` share. */
function planListWhere(applicationId: string, includeInactive: boolean): Prisma.PlanWhereInput {
  return {
    applicationId,
    ...(includeInactive
      ? {}
      : {
          active: true,
          registrationStatus: { notIn: ['PENDING', 'FAILED'] },
        }),
  };
}

export const plansService = {
  /**
   * `includeInactive` is the operator view; the default is the PUBLIC
   * catalogue, and the public catalogue only lists plans a buyer can actually
   * pay for. A plan mid-registration or one the provider refused is excluded on
   * its `registrationStatus` as well as on `active`, belt and braces: `active`
   * is operator-writable and this list is what a pricing page renders, so the
   * "no price behind it" fact gets its own filter rather than riding entirely
   * on a flag somebody can flip back.
   */
  async listForApplication(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<Plan[]> {
    return prisma.plan.findMany({
      where: planListWhere(applicationId, includeInactive),
      orderBy: [{ interval: 'asc' }, { amount: 'asc' }],
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  /**
   * Total Plans matching `listForApplication`'s filter, ignoring take/skip.
   * Shares the filter builder so the count cannot describe a different list.
   */
  async countForApplication(applicationId: string, includeInactive = false): Promise<number> {
    return prisma.plan.count({ where: planListWhere(applicationId, includeInactive) });
  },

  async getBySlug(applicationId: string, slug: string): Promise<Plan> {
    const plan = await prisma.plan.findUnique({
      where: { applicationId_slug: { applicationId, slug } },
    });
    if (!plan) {
      throw new RekeyError({
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
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_SLUG_INVALID',
        message: `Plan slug "${input.slug}" is not URL-safe.`,
        fix: 'Use lowercase letters, digits, underscores, and hyphens. Must start and end with alphanumerics. Max 40 chars.',
      });
    }
    if (input.amount < 0) {
      throw new RekeyError({
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
        throw new RekeyError({
          statusCode: 400,
          code: 'PLAN_LICENSE_KIND_REQUIRED',
          message: 'LICENSE-kind plans need `licenseKind` (PERPETUAL / TIMED / SEATS).',
          fix: 'Pick a license kind in the plan editor.',
        });
      }
      if (input.licenseKind === 'TIMED' && !input.licenseDurationDays) {
        throw new RekeyError({
          statusCode: 400,
          code: 'PLAN_LICENSE_DURATION_REQUIRED',
          message: 'TIMED licenses need a duration in days.',
          fix: 'Set `licenseDurationDays` (e.g. 365 for one year).',
        });
      }
      if (input.licenseKind === 'SEATS' && !input.licenseSeatsAllowed) {
        throw new RekeyError({
          statusCode: 400,
          code: 'PLAN_LICENSE_SEATS_REQUIRED',
          message: 'SEATS licenses need a seat count.',
          fix: 'Set `licenseSeatsAllowed` (e.g. 5 for a 5-seat pack).',
        });
      }
    }
    if (kind === 'USAGE') {
      if (!input.meterSlug || input.pricePerUnitCents === undefined) {
        throw new RekeyError({
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
        throw new RekeyError({
          statusCode: 400,
          code: 'PLAN_USAGE_METER_UNKNOWN',
          message: `Meter "${input.meterSlug}" not found in this Application.`,
          fix: 'Create the meter first on the Usage tab.',
        });
      }
    }
    if (kind === 'CREDIT') {
      if (input.creditsAmount === undefined || input.creditsAmount <= 0) {
        throw new RekeyError({
          statusCode: 400,
          code: 'PLAN_CREDITS_AMOUNT_REQUIRED',
          message: 'CREDIT-kind plans need a positive `creditsAmount` (credits granted per purchase).',
          fix: 'Set how many credits this pack grants, e.g. 100.',
        });
      }
    }

    const application: Application = await applicationsService.get(input.applicationId);

    // Decided BEFORE the insert, because it decides what state the insert
    // writes. ONLY when Stripe is actually configured. This used to be
    // unconditional, which was harmless while a stub absorbed the call and
    // became a bug the moment the stub was deleted: a PayPal-only or
    // Razorpay-only operator could no longer create any plan at all, and the
    // error they got named Stripe — a provider they had deliberately not set
    // up. Other providers already register lazily on first checkout, so
    // skipping here costs nothing but a first-checkout round-trip.
    const registersEagerly = await billingCredentialsService.isConfigured(
      input.applicationId,
      'stripe',
    );

    let plan: Plan;
    try {
      plan = await prisma.plan.create({
        data: {
          applicationId: input.applicationId,
          slug: input.slug,
          // Write-ahead: a plan awaiting a provider round-trip is inserted
          // un-purchasable and promoted afterwards, so no window exists in
          // which it is on sale without a price behind it. See the file header.
          ...(registersEagerly
            ? { active: false, registrationStatus: 'PENDING' as const }
            : { registrationStatus: 'NOT_REQUIRED' as const }),
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
        // Retrying the create is the first thing an operator does when a plan
        // came back broken, and "pick a different slug" was the wrong advice at
        // exactly that moment: the slug is already in someone's pricing page.
        // Name the repair for the state the existing row is actually in.
        const existing = await prisma.plan.findUnique({
          where: { applicationId_slug: { applicationId: input.applicationId, slug: input.slug } },
          select: { registrationStatus: true, active: true },
        });
        const broken =
          existing?.registrationStatus === 'FAILED' || existing?.registrationStatus === 'PENDING';
        // An ARCHIVED plan still holds its slug, and saying only "already
        // exists" sends the operator looking for a plan they believe they
        // removed. Archiving sets `active: false`; the row and its slug stay,
        // because the slug is the identifier integrator code passes to
        // checkout and reads back off a subscription. Releasing it would let a
        // NEW plan inherit an OLD one's public identity, silently changing what
        // `pro` means for every existing caller — a worse failure than this
        // refusal. Reported as #30.
        const archived = existing?.active === false;
        throw new RekeyError({
          statusCode: 409,
          code: 'PLAN_SLUG_TAKEN',
          message: archived
            ? `An ARCHIVED plan with slug "${input.slug}" already exists in this application. Archiving a plan does not release its slug.`
            : `A plan with slug "${input.slug}" already exists in this application.`,
          fix: broken
            ? `That plan exists but is not registered with the payment provider, so it is off the public catalogue. Fix the provider credentials if they were the problem, then repair it in place: PATCH /api/v1/tenant/applications/${input.applicationId}/plans/${input.slug} to correct name/price, and POST .../plans/${input.slug}/register to retry registration. You do not need a new slug.`
            : archived
              ? `The slug is a public identifier your integration passes to checkout and reads back off a subscription, so it stays reserved after archiving — otherwise a new plan would inherit the old one's meaning for every caller still using it. Either reactivate that plan and edit it in place (Panel → Plans → Reactivate, then Edit), or pick a different slug for the new one.`
              : 'Pick a different slug, or edit the existing plan with PATCH /api/v1/tenant/applications/:id/plans/:slug.',
        });
      }
      throw e;
    }

    // Registration, and the promotion out of the un-purchasable state it was
    // inserted in. Nothing below is inside a transaction, deliberately: see the
    // file header on why the ordering, not a transaction, is what makes this
    // safe.
    if (!registersEagerly) return plan;
    return registerAndSettle(application, plan);
  },

  /**
   * Retry provider registration for a plan that hasn't got one — the repair for
   * a create whose provider call was refused, and for a plan created before its
   * Application had Stripe credentials.
   *
   * Idempotent at both ends: `ensurePlanRegistered` returns the stored price id
   * without calling out when one exists, and a plan that is already REGISTERED
   * is answered from the row.
   *
   * Success re-activates a plan that FAILED or is stuck PENDING, because that
   * plan was deactivated by *us* and never by the operator — undoing our own
   * forced deactivation is the point of the call. A plan the operator retired
   * on purpose keeps its `active` flag: this is a registration operation, not a
   * publish button.
   */
  async registerWithProvider(applicationId: string, slug: string): Promise<Plan> {
    const application = await applicationsService.get(applicationId);
    const plan = await this.getBySlug(applicationId, slug);

    if (!(await billingCredentialsService.isConfigured(applicationId, 'stripe'))) {
      throw credentialsNotConfigured(application, 'stripe');
    }
    return registerAndSettle(application, plan);
  },

  /**
   * Retiring a plan is always allowed. PUTTING ONE ON SALE is not: a plan the
   * provider never registered has no price behind it, and flipping `active`
   * would publish it to the pricing page for a buyer to hit a dead checkout.
   * The refusal names the repair.
   */
  async setActive(applicationId: string, slug: string, active: boolean): Promise<Plan> {
    const plan = await this.getBySlug(applicationId, slug);
    if (active) assertActivatable(applicationId, plan);
    return prisma.plan.update({ where: { id: plan.id }, data: { active } });
  },

  /**
   * Edit a plan's ENTITLEMENTS in place — the things it grants, which live
   * entirely on the Rekey side and don't touch the provider-registered Price:
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

    const metadata =
      patch.metadata !== undefined ? mergeMetadata(plan, patch.metadata) : undefined;

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

  /**
   * The operator's edit surface for a plan — `active`, display name, metadata,
   * and, conditionally, the PRICE.
   *
   * This exists because "deactivate it and mint a new slug" is not a repair for
   * a plan whose slug is already embedded in a customer's pricing page. The API
   * used to accept exactly one field here (`active`), so a plan the provider had
   * refused could not be corrected at all: re-POSTing the slug answered 409, and
   * nothing else could touch the row.
   *
   * ## When the price may move
   *
   * Only while `hasProviderRegistration(plan)` is false — i.e. no provider has
   * minted a price object for this row yet. That is not a loosening of the old
   * rule, it is the same rule stated honestly: `amount`/`currency`/`interval`
   * were frozen because a Stripe Price is immutable once created and an edit
   * would make our row lie about what the buyer is charged. A plan that never
   * registered has no such object, so there is nothing to contradict — and
   * re-pricing is precisely what a currency- or amount-rejection needs before
   * registration can be retried. Once REGISTERED the fields lock again, and the
   * refusal says so.
   */
  async update(
    applicationId: string,
    slug: string,
    patch: {
      active?: boolean;
      name?: string;
      amount?: number;
      currency?: string;
      interval?: PlanInterval;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Plan> {
    const plan = await this.getBySlug(applicationId, slug);
    if (patch.active === true) assertActivatable(applicationId, plan);

    const pricePatched =
      patch.amount !== undefined || patch.currency !== undefined || patch.interval !== undefined;
    if (pricePatched && hasProviderRegistration(plan)) {
      throw new RekeyError({
        statusCode: 409,
        code: 'PLAN_PRICE_IMMUTABLE',
        message: `Plan "${slug}" is already registered with a payment provider, so its price cannot be changed.`,
        fix: 'A provider price object is immutable once created. Retire this plan (PATCH with {"active": false}) and create a replacement at the new price. Price edits are only accepted on a plan that has never registered.',
      });
    }
    if (patch.amount !== undefined && patch.amount < 0) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_AMOUNT_INVALID',
        message: 'Plan amount must be >= 0 (smallest currency unit, e.g. cents).',
        fix: 'Send the price in cents (or paise/sen/etc.) — never as a decimal float.',
      });
    }

    const metadata =
      patch.metadata !== undefined ? mergeMetadata(plan, patch.metadata) : undefined;

    return prisma.plan.update({
      where: { id: plan.id },
      data: {
        ...(patch.active !== undefined && { active: patch.active }),
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.amount !== undefined && { amount: patch.amount }),
        ...(patch.currency !== undefined && { currency: patch.currency.toUpperCase() }),
        ...(patch.interval !== undefined && { interval: patch.interval }),
        ...(metadata !== undefined && { metadata: metadata as object }),
      },
    });
  },
};

/**
 * Refuse to publish a plan the provider has never acknowledged. Guards every
 * path that can set `active: true` from the outside — the only writer allowed
 * past it is `registerAndSettle`, which flips the flag as the last step of a
 * registration that just succeeded.
 */
function assertActivatable(applicationId: string, plan: Plan): void {
  if (plan.registrationStatus === 'PENDING' || plan.registrationStatus === 'FAILED') {
    throw planNotRegisteredError({
      planSlug: plan.slug,
      provider: 'stripe',
      applicationId,
    });
  }
}

/** What we keep on the row out of a provider refusal. Bounded, never thrown. */
function registrationErrorText(e: unknown): string {
  const raw = e instanceof Error && e.message ? e.message : String(e);
  return raw.slice(0, REGISTRATION_ERROR_MAX);
}

/**
 * Register a plan with Stripe and settle its `registrationStatus` around the
 * call. The one place the local↔provider boundary is crossed for plans.
 *
 * The status write happens on BOTH sides of the network call and never inside a
 * database transaction — a `$transaction` held across a 10-second Stripe
 * round-trip would pin a connection and lock the row for the duration, and
 * would still not be atomic with the provider, which has no way to join it.
 *
 * `blocked` is what the settling is FOR: a plan that is PENDING or FAILED is
 * un-purchasable because this function's own contract put it there, so this
 * function is entitled to flip `active` in either direction. A NOT_REQUIRED or
 * already-REGISTERED plan is live for reasons of its own — a Razorpay-only app
 * that later added Stripe keys, say — and a failed Stripe promotion must not
 * take it off sale.
 */
async function registerAndSettle(application: Application, plan: Plan): Promise<Plan> {
  const blocked = plan.registrationStatus === 'PENDING' || plan.registrationStatus === 'FAILED';

  // Back to PENDING before a retry, so a row cannot read FAILED while a
  // registration for it is in flight.
  let current = plan;
  if (plan.registrationStatus === 'FAILED') {
    current = await prisma.plan.update({
      where: { id: plan.id },
      data: { active: false, registrationStatus: 'PENDING', registrationError: null },
    });
  }

  const provider = await getProviderForApplication(application, 'stripe');
  let providerPlanId: string;
  try {
    providerPlanId = (await provider.ensurePlanRegistered(current)).providerPlanId;
  } catch (e) {
    if (blocked) {
      try {
        await prisma.plan.update({
          where: { id: current.id },
          data: {
            active: false,
            registrationStatus: 'FAILED',
            registrationError: registrationErrorText(e),
          },
        });
      } catch {
        // Best-effort annotation only. The row is already PENDING + inactive —
        // un-purchasable, which is the state that matters — and replacing the
        // provider's refusal with a database error would hide the one thing the
        // caller can act on.
      }
    }
    // The row records the provider's OWN text (above), because that is what
    // tells the operator which credential is wrong. What leaves this function
    // is the mapped error: a raw StripeError reaching the global handler kept
    // its own `.statusCode` and answered `401 {code:"BAD_REQUEST", message:
    // "Invalid API Key provided: sk_test_…", fix:"Check the request shape
    // against the route schema"}` — three disagreeing signals for one bad
    // stored credential. Raw for the record, mapped for the caller.
    throw providerError({
      provider: 'stripe',
      operation: 'plan registration',
      audience: 'operator',
      error: e,
    });
  }

  return prisma.plan.update({
    where: { id: current.id },
    data: {
      metadata: {
        ...(current.metadata as object),
        stripe: { priceId: providerPlanId },
      } as never,
      registrationStatus: 'REGISTERED',
      registrationError: null,
      ...(blocked && { active: true }),
    },
  });
}
