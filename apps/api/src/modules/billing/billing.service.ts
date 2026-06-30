/**
 * Billing service — public surface used by `@relipay/node`.
 *
 * Three operations today:
 *   - listPlans(application)              → public plan catalogue
 *   - getCurrentSubscription(app, eu)     → that user's active sub, if any
 *   - createCheckoutSession(app, eu, slug, urls) → returns provider URL
 *
 * Subscription activation, payment recording, and status transitions all
 * happen via webhook events from the provider — *not* synchronously here.
 * The local `Subscription` row is created in `PENDING` state at checkout
 * and flips to `ACTIVE` when the webhook fires (see
 * `webhooks/stripe.handler.ts` + `webhooks/paypal.handler.ts`, both live).
 */

import type { Application, DataMode, EndUser, Plan, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { plansService } from '../plans/plans.service.js';
import { couponsService } from '../coupons/coupons.service.js';
import { getProviderForApplication, pickProvider } from './providers/index.js';
import type { BillingProviderName } from './credentials.service.js';
import { BillingConfigSchema } from '@relipay/shared-types';
import { emitSubscriptionEvent } from './webhooks/billing-events.js';

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
    /**
     * Test/live isolation: the calling secret key's mode. TEST checkouts only
     * select test-mode (sandbox) billing credentials and stamp the resulting
     * Subscription with mode TEST. Defaults to LIVE.
     */
    dataMode?: DataMode;
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
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_ORGANIZATION_REQUIRED',
        message: 'This Application bills per organization, but no organization was provided for checkout.',
        fix: 'Pass `organizationId` of a team the user OWNS or ADMINS (set the session\'s active org via organizations.switch, or pass organizationId to createCheckout). Change the model in Panel → Application → Billing → Subject.',
      });
    }

    const plan = await plansService.getBySlug(input.application.id, input.planSlug);
    if (!plan.active) {
      throw new RelipayError({
        statusCode: 400,
        code: 'PLAN_INACTIVE',
        message: `Plan "${input.planSlug}" is not currently available for new sign-ups.`,
        fix: 'Pick a different active plan, or have an admin re-enable this one via PATCH /api/v1/admin/applications/:id/plans/:slug.',
      });
    }

    let couponContext: { couponId: string; discountAmount: number } | null = null;
    if (input.couponCode) {
      const validated = await couponsService.validate({
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        code: input.couponCode,
        planSlug: plan.slug,
        amount: plan.amount,
        currency: plan.currency,
      });
      couponContext = { couponId: validated.coupon.id, discountAmount: validated.discountAmount };
    }

    const dataMode: DataMode = input.dataMode ?? 'LIVE';
    const providerName = await pickProvider({
      application: input.application,
      ...(input.country !== undefined && { country: input.country }),
      ...(input.provider !== undefined && { preferred: input.provider }),
      dataMode,
    });

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
      throw new RelipayError({
        statusCode: 409,
        code: 'BILLING_PROVIDER_SWITCH_BLOCKED',
        message: `You already have an active subscription on this plan via "${existing.provider}". Cancel it first to switch to "${providerName}".`,
        fix: 'Cancel the current subscription, wait for it to terminate, then start a new checkout.',
      });
    }

    const provider = await getProviderForApplication(input.application, providerName);
    // CREDIT packs + perpetual (non-TIMED) licenses are one-off purchases —
    // route them through the provider's one-time payment flow so they DON'T
    // create a recurring subscription. TIMED licenses + SUBSCRIPTION plans
    // recur. Fulfillment (credit grant / license issue) still lands on the
    // payment-completed webhook either way.
    const isOneTime =
      plan.kind === 'CREDIT' || (plan.kind === 'LICENSE' && plan.licenseKind !== 'TIMED');
    const checkoutInput = {
      application: { id: input.application.id, slug: input.application.slug },
      endUser: input.endUser,
      plan,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    };
    const session = isOneTime
      ? await provider.createOneTimeCheckout(checkoutInput)
      : await provider.createCheckoutSession(checkoutInput);

    // Upsert by (applicationId, endUserId, planId): if the user already started
    // checkout for this same plan and bailed, reuse that PENDING row instead
    // of creating a parallel one.
    const subscriptionMetadata: Record<string, unknown> = {
      checkoutSessionId: session.sessionId,
      ...(isOneTime && { oneTime: true }),
    };
    if (couponContext) {
      subscriptionMetadata.couponId = couponContext.couponId;
      subscriptionMetadata.discountAmount = couponContext.discountAmount;
    }
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
        mode: dataMode,
        ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
        metadata: subscriptionMetadata as never,
      },
      update: {
        provider: providerName,
        status: 'PENDING',
        mode: dataMode,
        ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
        metadata: subscriptionMetadata as never,
      },
    });

    // Redemption is NOT recorded here. The coupon id rides on
    // `subscription.metadata.couponId` and is consumed at payment-success
    // time in `webhooks/stripe.handler.ts > onInvoicePaid`. Recording at
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
      throw new RelipayError({
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

    const now = new Date();
    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
    });
    emitSubscriptionEvent('subscription.canceled', updated.id);
    // Self-service cancel while PAST_DUE — close the dunning case (silently).
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
