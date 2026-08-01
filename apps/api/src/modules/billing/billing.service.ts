/**
 * Billing service — public surface used by `@rekey.dev/node`.
 *
 * Core operations:
 *   - listActivePlans(application)        → public plan catalogue
 *   - getCurrentSubscription(app, eu)     → that user's active sub, if any
 *   - createCheckoutSession(app, eu, slug, urls) → returns provider URL
 *
 * Plus the self-service reads and the cancel path the hosted portal drives —
 * see the exported object at the bottom of the file for the full list.
 *
 * Subscription activation, payment recording, and status transitions all
 * happen via webhook events from the provider — *not* synchronously here.
 * The local `Subscription` row is created in `PENDING` state at checkout
 * and flips to `ACTIVE` when the webhook fires (see the provider modules'
 * `translate` + the shared appliers in `webhooks/apply.ts`).
 */

import type { Application, EndUser, Plan, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { plansService } from '../plans/plans.service.js';
import { couponsService } from '../coupons/coupons.service.js';
import { resolveCheckoutDiscount } from './checkout-discount.js';
import { buildCheckoutSessionMetadata } from './checkout-sessions.js';
import { getProviderForApplication, pickProvider } from './providers/index.js';
import type { BillingProviderName } from './credentials.service.js';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';

/**
 * End-user-facing payment row (GET /api/v1/billing/payments). A deliberate
 * projection — internal correlation ids (providerPaymentId) and raw metadata
 * stay server-side; `receiptUrl` is surfaced when a provider receipt link was
 * stamped onto the payment's metadata (`receiptUrl` / `receipt_url`).
 */
export interface EndUserPaymentDto {
  id: string;
  amount: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  description: string | null;
  createdAt: Date;
  subscriptionId: string | null;
  /** Slug of the plan the payment's subscription is on, when resolvable. */
  planSlug: string | null;
  /** Provider-hosted receipt URL, when present in the payment metadata. */
  receiptUrl: string | null;
}

/**
 * Statuses that mean the buyer is currently paying for this subscription.
 *
 * PAST_DUE is included: the dunning window exists precisely so a failed charge
 * does not immediately revoke what has been bought, and the portal treats it
 * as entitled too. Only these are protected from being reset by a new checkout.
 */
function isEntitled(status: Subscription['status'] | undefined): boolean {
  return status === 'ACTIVE' || status === 'PAST_DUE';
}

/** Pull a usable https receipt link out of a payment's metadata, if any. */
function receiptUrlFromMetadata(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const candidate = m.receiptUrl ?? m.receipt_url;
  if (typeof candidate !== 'string') return null;
  // Only http(s) links leave the API — a metadata key is operator-writable,
  // so refuse javascript:/data: and other schemes outright.
  return /^https?:\/\//i.test(candidate) ? candidate : null;
}

export const billingService = {
  async listActivePlans(application: Application): Promise<Plan[]> {
    return plansService.listForApplication(application.id, false);
  },

  /**
   * The active subscription for the caller — their own by default, or an
   * organization's when `opts.organizationId` is given (org-billed apps). The
   * caller's membership/role is checked at the route layer before this runs.
   */
  async getCurrentSubscription(
    application: Application,
    endUser: EndUser,
    opts?: { organizationId?: string },
  ): Promise<Subscription | null> {
    return prisma.subscription.findFirst({
      where: {
        applicationId: application.id,
        status: { in: ['ACTIVE', 'PAST_DUE', 'PENDING'] },
        ...(opts?.organizationId
          ? { beneficiaryOrgId: opts.organizationId }
          : { endUserId: endUser.id }),
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Create a checkout session for an end-user against a named plan. Returns
   * the provider's hosted URL and a local PENDING Subscription row.
   *
   * The Subscription row is created locally so we can correlate the
   * eventual webhook back to it; the provider's session id lives on
   * `Subscription.metadata.checkoutSessionId`.
   */
  async createCheckoutSession(input: {
    application: Application;
    endUser: EndUser;
    planSlug: string;
    successUrl: string;
    cancelUrl: string;
    /** Optional coupon code to apply at checkout. Validated, redeemed atomically. */
    couponCode?: string;
    /**
     * End-user's chosen provider. When omitted, the geo router picks one
     * from the configured set using `country` and the per-provider
     * `countries`/`priority` settings.
     */
    provider?: BillingProviderName;
    /** ISO 3166-1 alpha-2, used by the geo router when `provider` is absent. */
    country?: string;
    /** Beneficiary org (owner+beneficiary). The route asserts the caller is an
     *  OWNER/ADMIN of it before passing it here. Null/absent = bill the owner. */
    beneficiaryOrgId?: string;
  }): Promise<{
    url: string;
    subscription: Subscription;
    /** Discount applied (smallest currency unit). 0 when no coupon was given. */
    discountAmount: number;
    /** Which provider issued this checkout. Stamped on the Subscription row. */
    provider: BillingProviderName;
  }> {
    // When the Application bills per organization (owner+beneficiary), a
    // checkout MUST name a beneficiary org — an individual can't hold the sub.
    // Surface a clear hint instead of silently creating a user-subject sub
    // (the mistake an AI agent / new integrator makes first).
    const billingConfig = BillingConfigSchema.parse(input.application.billingConfig);
    if (billingConfig.billingSubject === 'org' && input.beneficiaryOrgId === undefined) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_ORGANIZATION_REQUIRED',
        message: 'This Application bills per organization, but no organization was provided for checkout.',
        fix: 'Pass `organizationId` of a team the user OWNS or ADMINS (set the session\'s active org via organizations.switch, or pass organizationId to createCheckout). Change the model in Panel → Application → Billing → Subject.',
      });
    }

    const plan = await plansService.getBySlug(input.application.id, input.planSlug);
    if (!plan.active) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_INACTIVE',
        message: `Plan "${input.planSlug}" is not currently available for new sign-ups.`,
        fix: 'Pick a different active plan, or have an admin re-enable this one via PATCH /api/v1/admin/applications/:id/plans/:slug.',
      });
    }

    // CREDIT packs + perpetual (non-TIMED) licenses are one-off purchases —
    // route them through the provider's one-time payment flow so they DON'T
    // create a recurring subscription. TIMED licenses + SUBSCRIPTION plans
    // recur. Fulfillment (credit grant / license issue) still lands on the
    // payment-completed webhook either way.
    const isOneTime =
      plan.kind === 'CREDIT' || (plan.kind === 'LICENSE' && plan.licenseKind !== 'TIMED');

    let couponContext: { couponId: string; code: string; discountAmount: number } | null = null;
    if (input.couponCode) {
      const validated = await couponsService.validate({
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        code: input.couponCode,
        planSlug: plan.slug,
        amount: plan.amount,
        currency: plan.currency,
      });
      couponContext = {
        couponId: validated.coupon.id,
        code: validated.coupon.code,
        discountAmount: validated.discountAmount,
      };
    }

    const providerName = await pickProvider({
      application: input.application,
      ...(input.country !== undefined && { country: input.country }),
      ...(input.provider !== undefined && { preferred: input.provider }),
    });

    // Resolved as soon as the provider is known and BEFORE any row is written:
    // whether the discount can actually be charged depends on the provider and
    // the flow, and a checkout that cannot honour the coupon must fail while
    // it still costs nothing. See checkout-discount.ts for what it refuses.
    const discount = couponContext
      ? resolveCheckoutDiscount({ plan, provider: providerName, isOneTime, coupon: couponContext })
      : null;

    // Guard: if the user already has an ACTIVE/PAST_DUE sub on this plan
    // bound to a different provider, refuse the switch — they need to
    // cancel first. Subscription.provider is immutable once active.
    const existing = await prisma.subscription.findUnique({
      where: {
        applicationId_endUserId_planId: {
          applicationId: input.application.id,
          endUserId: input.endUser.id,
          planId: plan.id,
        },
      },
    });
    if (
      existing &&
      existing.provider &&
      existing.provider !== providerName &&
      (existing.status === 'ACTIVE' || existing.status === 'PAST_DUE')
    ) {
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_PROVIDER_SWITCH_BLOCKED',
        message: `You already have an active subscription on this plan via "${existing.provider}". Cancel it first to switch to "${providerName}".`,
        fix: 'Cancel the current subscription, wait for it to terminate, then start a new checkout.',
      });
    }

    const provider = await getProviderForApplication(input.application, providerName);
    const checkoutInput = {
      application: { id: input.application.id, slug: input.application.slug },
      endUser: input.endUser,
      plan,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      // The discount goes to the PROCESSOR, not just onto our own rows. It
      // used to stop at `couponContext` below, so every coupon ever applied
      // charged the buyer full price while we recorded a discount and
      // redeemed the code.
      ...(discount !== null && { discount }),
    };
    const session = isOneTime
      ? await provider.createOneTimeCheckout(checkoutInput)
      : await provider.createCheckoutSession(checkoutInput);

    // Upsert by (applicationId, endUserId, planId): if the user already started
    // checkout for this same plan and bailed, reuse that PENDING row instead
    // of creating a parallel one.
    //
    // The metadata REMEMBERS the earlier sessions rather than overwriting them.
    // Overwriting stranded any still-live provider session — a Stripe Checkout
    // Session stays completable for ~24h — so a buyer who reopened checkout and
    // then went back and paid on the first tab matched no local row: 200 OK,
    // row still PENDING, no payment, no redemption, no trace of a real sale.
    // See checkout-sessions.ts.
    const subscriptionMetadata = buildCheckoutSessionMetadata({
      previous: existing?.metadata ?? null,
      sessionId: session.sessionId,
      isOneTime,
      coupon: couponContext
        ? { couponId: couponContext.couponId, discountAmount: couponContext.discountAmount }
        : null,
    });
    const subscription = await prisma.subscription.upsert({
      where: {
        applicationId_endUserId_planId: {
          applicationId: input.application.id,
          endUserId: input.endUser.id,
          planId: plan.id,
        },
      },
      create: {
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        planId: plan.id,
        provider: providerName,
        status: 'PENDING',
        ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
        metadata: subscriptionMetadata as never,
      },
      update: {
        provider: providerName,
        // An ALREADY-PAYING row is not reset to PENDING. Opening a checkout is
        // not an event that removes entitlement, and this unconditionally made
        // it one: an ACTIVE subscriber who merely pressed Upgrade — or typed a
        // coupon into the form the account page now shows *existing*
        // subscribers — was downgraded on the spot. PENDING is not an
        // entitling status, so their portal showed them as unsubscribed and
        // every entitlement gate started refusing, without a single provider
        // event having happened. The provider's webhook is what moves a paying
        // subscription between states; this row is only a checkout record.
        ...(isEntitled(existing?.status) ? {} : { status: 'PENDING' as const }),
        ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
        metadata: subscriptionMetadata as never,
      },
    });

    // Redemption is NOT recorded here. The coupon rides on
    // `subscription.metadata.couponBySession` and is consumed when the
    // provider says the purchase completed (`webhooks/apply.ts`). Recording at
    // checkout-creation was abusable — an attacker could apply a coupon,
    // abandon checkout, and exhaust the per-user / global redemption
    // limit for legitimate users. See decisions.md 2026-05-19.

    return {
      url: session.url,
      subscription,
      discountAmount: couponContext?.discountAmount ?? 0,
      provider: providerName,
    };
  },

  /**
   * The calling end-user's OWN payment history, newest first. Strictly
   * scoped by `(applicationId, endUserId)` — there is no way to read another
   * user's rows through this surface. Org-billed subscriptions keep the
   * owner as the payer (`Payment.endUserId`), so an org owner sees those
   * payments here too.
   */
  async listPaymentsForEndUser(
    application: Application,
    endUserId: string,
    opts?: { limit?: number },
  ): Promise<EndUserPaymentDto[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const rows = await prisma.payment.findMany({
      where: { applicationId: application.id, endUserId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { subscription: { select: { plan: { select: { slug: true } } } } },
    });
    return rows.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      description: p.description,
      createdAt: p.createdAt,
      subscriptionId: p.subscriptionId,
      planSlug: p.subscription?.plan.slug ?? null,
      receiptUrl: receiptUrlFromMetadata(p.metadata),
    }));
  },

  /**
   * Cancel the calling end-user's current subscription (self-service portal
   * surface). Semantics:
   *
   *   - No ACTIVE/PAST_DUE/PENDING subscription → 404 SUBSCRIPTION_NOT_FOUND.
   *   - Default (`atPeriodEnd !== false`) on an ACTIVE provider-backed sub
   *     with a known period end → the provider is told to stop at period end
   *     and the local row records `cancelAt = currentPeriodEnd` while staying
   *     ACTIVE. The status flips to CANCELED when the provider's webhook
   *     announces the actual termination (subscription.deleted / .updated).
   *   - Everything else (PENDING checkout that never activated, PAST_DUE,
   *     immediate cancel, or a sub with no provider-side id) → local status
   *     update to CANCELED now; the provider is still told to cancel when a
   *     provider-side subscription exists. Emits `subscription.canceled`.
   *
   * Idempotent: cancelling an already-pending-cancel sub returns it unchanged.
   */
  async cancelCurrentSubscription(
    application: Application,
    endUser: EndUser,
    opts?: { atPeriodEnd?: boolean; organizationId?: string },
  ): Promise<Subscription> {
    const sub = await this.getCurrentSubscription(
      application,
      endUser,
      opts?.organizationId ? { organizationId: opts.organizationId } : undefined,
    );
    if (!sub) {
      throw new RekeyError({
        statusCode: 404,
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'You have no active subscription to cancel.',
        fix: 'Nothing to do — the user is not subscribed (or the subscription is already canceled).',
      });
    }

    const providerBacked = Boolean(sub.provider && sub.providerSubId);
    const atPeriodEnd =
      opts?.atPeriodEnd !== false &&
      providerBacked &&
      sub.status === 'ACTIVE' &&
      sub.currentPeriodEnd !== null;

    // Already scheduled to cancel at period end → idempotent no-op.
    if (atPeriodEnd && sub.cancelAt !== null) return sub;

    if (providerBacked) {
      const provider = await getProviderForApplication(
        application,
        sub.provider as BillingProviderName,
      );
      await provider.cancelSubscription({ subscription: sub, atPeriodEnd });
    }

    if (atPeriodEnd) {
      // Stays ACTIVE until the provider terminates it; record the scheduled
      // end so portals can render "cancels on <date>".
      return prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAt: sub.currentPeriodEnd },
      });
    }

    // Cancel + its outbox row in one transaction: the customer's own cancel is
    // a state change a consumer has to hear about, so it must not be able to
    // commit without the announcement (see webhooks/apply.ts).
    const now = new Date();
    const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
      const row = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
      });
      return {
        updated: row,
        deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.canceled', row.id),
      };
    });
    kickDeliveries(deliveryIds);
    // Self-service cancel while PAST_DUE — close the dunning case (silently).
    const { dunningService } = await import('./dunning.service.js');
    await dunningService.closeForCanceledSubscription(updated.id);
    return updated;
  },

  /**
   * Operator-facing cancel of a SPECIFIC subscription by id (e.g. via the
   * operator MCP `cancel_subscription` tool). Mirrors `cancelCurrentSubscription`
   * but targets one row instead of the end-user's "current" one — so it's
   * unambiguous when a user has more than one subscription. The subscription
   * MUST belong to `application` (the caller resolves the application within
   * the operator's tenant first), so this can't reach across workspaces.
   */
  async cancelSubscriptionById(
    application: Application,
    subscriptionId: string,
    opts?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const sub = await prisma.subscription.findFirst({
      where: { id: subscriptionId, applicationId: application.id },
    });
    if (!sub) {
      throw new RekeyError({
        statusCode: 404,
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: `Subscription "${subscriptionId}" not found in this application.`,
        fix: 'List subscriptions and use an id this application owns.',
      });
    }
    if (sub.status === 'CANCELED' || sub.status === 'EXPIRED') return sub;

    const providerBacked = Boolean(sub.provider && sub.providerSubId);
    const atPeriodEnd =
      opts?.atPeriodEnd !== false &&
      providerBacked &&
      sub.status === 'ACTIVE' &&
      sub.currentPeriodEnd !== null;

    // Idempotent: already scheduled to cancel at period end.
    if (atPeriodEnd && sub.cancelAt !== null) return sub;

    if (providerBacked) {
      const provider = await getProviderForApplication(
        application,
        sub.provider as BillingProviderName,
      );
      await provider.cancelSubscription({ subscription: sub, atPeriodEnd });
    }

    if (atPeriodEnd) {
      return prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAt: sub.currentPeriodEnd },
      });
    }

    // Same transactional cancel + announce as cancelCurrentSubscription.
    const now = new Date();
    const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
      const row = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
      });
      return {
        updated: row,
        deliveryIds: await enqueueSubscriptionEvent(tx, 'subscription.canceled', row.id),
      };
    });
    kickDeliveries(deliveryIds);
    const { dunningService } = await import('./dunning.service.js');
    await dunningService.closeForCanceledSubscription(updated.id);
    return updated;
  },

  /**
   * Cancel every still-billing provider subscription belonging to an end-user.
   * Used by the operator end-user delete / GDPR-erasure paths so the provider
   * (Stripe/PayPal/Razorpay) stops billing a row we are about to remove or
   * tombstone — otherwise the provider keeps charging a vanished user.
   *
   * Cancels immediately (`atPeriodEnd: false`) at the provider for each
   * ACTIVE/PAST_DUE subscription that has a provider-side id. Same
   * `BillingProvider.cancelSubscription` path the portal cancel + dunning
   * exhaustion use. BEST-EFFORT: a provider error must NOT block the
   * delete/erase — we log and continue, so the user is always removed. The
   * local row's status is intentionally left untouched (the delete/erase
   * caller removes or tombstones it next).
   *
   * Returns the count of subscriptions for which a provider cancel was
   * attempted (for the audit metadata).
   */
  async cancelActiveProviderSubscriptionsForEndUser(args: {
    application: Application;
    endUserId: string;
    log?: { warn: (obj: unknown, msg: string) => void };
  }): Promise<{ attempted: number; failed: number }> {
    const subs = await prisma.subscription.findMany({
      where: {
        applicationId: args.application.id,
        endUserId: args.endUserId,
        status: { in: ['ACTIVE', 'PAST_DUE'] },
        provider: { not: null },
        providerSubId: { not: null },
      },
    });
    let attempted = 0;
    let failed = 0;
    for (const sub of subs) {
      attempted += 1;
      try {
        const provider = await getProviderForApplication(
          args.application,
          sub.provider as BillingProviderName,
        );
        await provider.cancelSubscription({ subscription: sub, atPeriodEnd: false });
      } catch (err) {
        failed += 1;
        args.log?.warn(
          { err, subscriptionId: sub.id, provider: sub.provider },
          'end-user delete/erase: provider-side subscription cancel failed (continuing)',
        );
      }
    }
    return { attempted, failed };
  },
};
