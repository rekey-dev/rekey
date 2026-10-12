/**
 * Opens a checkout: resolves the buyer's price and provider, binds or creates
 * the PENDING subscription, reserves the coupon and the trial, asks the
 * provider for a session, and records it.
 */

import type { Application, EndUser, Plan, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { reportingCurrency } from './reporting-currency.js';
import { RekeyError } from '../../lib/error.js';
import { costsNothing } from './free-plan.js';
import { providerError } from '../../lib/provider-errors.js';
import { plansService } from '../plans/plans.service.js';
import { couponsService } from '../coupons/coupons.service.js';
import { resolveCheckoutDiscount } from './checkout-discount.js';
import { resolveCheckoutTrial } from './checkout-trial.js';
import { isOneTimePlan } from './plan-kind.js';
import { releaseTrial, bindTrialToSession } from './trial-eligibility.service.js';

import { buildCheckoutSessionMetadata } from './checkout-sessions.js';
import { getProviderForApplication, pickProvider } from './providers/index.js';
import type { BillingProviderName } from './credentials.service.js';
import { BillingConfigSchema, isEntitlingStatus } from '@rekey.dev/shared-types';
import { resolveCheckoutPresentation, type CheckoutPresentation } from './checkout/presentation.js';
import { issueProviderCheckout, recordIssuedCheckout, type IssuedCheckout } from './checkout/issue.js';
import type { BuyerCountrySource } from './buyer-country.js';
import { assertNoApprovalInFlight } from './checkout/in-flight.js';
import { resolveCheckoutPrice, unavailableCurrencyRule } from './checkout-price-resolution.js';
import type { CheckoutPrice } from './checkout-price.js';
import { malformedPlanCurrency } from '../plans/default-price.js';
import { findBindingSubscription } from './checkout-binding.js';
import { assertBindingAllowsCheckout, assertSubjectUnchanged } from './checkout-binding-refusals.js';
import { claimCheckout } from './checkout-claim.js';
import { assertCheckoutSubject } from './checkout-subject.js';
import { ensurePlanPriceRegistered } from './plan-price-registration.js';
/**
 * Create a checkout session for an end-user against a named plan. Returns
 * the provider's hosted URL and a local PENDING Subscription row.
 *
 * The Subscription row is created locally so we can correlate the
 * eventual webhook back to it; the provider's session id lives on
 * `Subscription.metadata.checkoutSessionId`.
 */
export async function createCheckoutSession(input: {
  application: Application;
  endUser: EndUser;
  planSlug: string;
  successUrl: string;
  cancelUrl: string;
  /** Optional coupon code to apply at checkout. Validated, and its redemption
   *  slot RESERVED before the provider mints the discount. */
  couponCode?: string;
  /**
   * End-user's chosen provider. When omitted, the geo router picks one
   * from the configured set using `country` and the per-provider
   * `countries`/`priority` settings.
   */
  provider?: BillingProviderName;
  /** ISO 3166-1 alpha-2, used by the geo router when `provider` is absent. */
  country?: string;
  /** Where `country` came from, recorded on the checkout session. */
  countrySource?: BuyerCountrySource;
  /**
   * Charge the plan's price in this currency. Honoured only with
   * `callerIsSecretKey`; from any other caller it refuses the checkout.
   */
  currency?: string;
  /**
   * What to do when no provider can charge `currency`: `fallback` charges the
   * plan's default price and logs it, `refuse` answers
   * `BILLING_NO_PROVIDER_FOR_CURRENCY`. Left out, the Application's
   * `billingConfig.onUnavailableCurrency` decides.
   */
  onUnavailableCurrency?: 'fallback' | 'refuse';
  /** True when the request was authenticated with the Application's secret key. */
  callerIsSecretKey?: boolean;
  /** Beneficiary org (owner+beneficiary). The route asserts the caller is an
   *  OWNER/ADMIN of it before passing it here. Null/absent = bill the owner. */
  beneficiaryOrgId?: string;
  /**
   * Proceed at full price for a buyer who has already used their free trial.
   *
   * A request-level acknowledgement, not a setting: it belongs at the call
   * site that rendered the price, because that is the only place that knows
   * what the buyer was shown. Without it an ineligible buyer is refused with
   * `BILLING_TRIAL_ALREADY_USED` rather than silently charged.
   */
  allowWithoutTrial?: boolean;
  /** `redirect` forces the provider's page; otherwise the Application's setting decides. */
  mode?: 'redirect' | 'embedded';
}): Promise<{
  url: string;
  subscription: Subscription;
  /** Discount applied (smallest currency unit). 0 when no coupon was given. */
  discountAmount: number;
  /** The currency this checkout charges, upper-case. */
  currency: string;
  /** The plan price selected, before any discount, in the smallest unit of `currency`. */
  unitAmount: number;
  /** The price charged and why it was selected. Null for a plan with no flat price. */
  price: CheckoutPrice | null;
  /** Which provider issued this checkout. Stamped on the Subscription row. */
  provider: BillingProviderName;
  /** True when `url` is the Rekey-hosted checkout page. */
  embedded: boolean;
  checkoutSessionId: string;
  /** The readiness check that sent an EMBEDDED checkout to the provider's page. */
  fellBack: CheckoutPresentation['fellBack'];
  paymentMode: CheckoutPresentation['paymentMode'];
}> {
  const billingConfig = BillingConfigSchema.parse(input.application.billingConfig);
  assertCheckoutSubject(billingConfig.billingSubject, input.beneficiaryOrgId);

  const plan = await plansService.getBySlug(input.application.id, input.planSlug);
  if (!plan.active) throw planInactive(input.application.id, plan);
  // With no price row it would be sold as a plan with no flat price: for nothing.
  const malformedCurrency = malformedPlanCurrency(plan);
  if (malformedCurrency !== null) {
    throw new RekeyError({
      statusCode: 409,
      code: 'PLAN_CURRENCY_INVALID',
      message: `Plan "${plan.slug}" cannot be bought: it is stored with the currency "${malformedCurrency}", which is not a three-letter ISO 4217 code.`,
      fix: `The operator sets the plan's price again with PATCH /api/v1/tenant/applications/${input.application.id}/plans/${plan.slug} and a body such as {"amount": 2000, "currency": "USD"}. Nothing was charged.`,
    });
  }

  // CREDIT packs + perpetual (non-TIMED) licenses are one-off purchases,
  // route them through the provider's one-time payment flow so they DON'T
  // create a recurring subscription. TIMED licenses + SUBSCRIPTION plans
  // recur. Fulfillment (credit grant / license issue) still lands on the
  // payment-completed webhook either way.
  const isOneTime = isOneTimePlan(plan);

  // Which processor this buyer is ALREADY paying through, if any. Resolved
  // before the router runs, because it outranks the router. See
  // checkout-binding.ts for what binds and why.
  const bound = isOneTime
    ? null
    : await findBindingSubscription({
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        beneficiaryOrgId: input.beneficiaryOrgId,
        planId: plan.id,
      });
  const boundProvider = bound?.provider ?? null;
  await assertBindingAllowsCheckout({ applicationId: input.application.id, bound, requestedProvider: input.provider });

  // The price is settled BEFORE the provider: routing may only pick a
  // provider that can charge the currency selected. From here on `priced` is
  // what the buyer pays, and `plan` is only the plan's identity.
  //
  // `namedProvider` is the caller's `provider` as far as it still counts: a
  // browser's is dropped when that provider cannot charge the price selected.
  const {
    priced,
    price: selectedPrice,
    provider: namedProvider,
  } = await resolveCheckoutPrice({
    applicationId: input.application.id,
    plan,
    localPrices: billingConfig.localPrices,
    unpricedCurrency: reportingCurrency(input.application),
    callerIsSecretKey: input.callerIsSecretKey === true,
    requestedCurrency: input.currency,
    onUnavailableCurrency: unavailableCurrencyRule(input.onUnavailableCurrency, billingConfig),
    country: input.country,
    countrySource: input.countrySource,
    bound,
    boundProvider: (boundProvider ?? undefined) as BillingProviderName | undefined,
    namedProvider: input.provider,
  });

  // Validated against the price selected, after any fall back to the default
  // price, so a fixed-amount coupon is judged in the currency charged.
  let couponContext: { couponId: string; code: string; discountAmount: number } | null = null;
  if (input.couponCode) {
    const validated = await couponsService.validate({
      applicationId: input.application.id,
      endUserId: input.endUser.id,
      code: input.couponCode,
      planSlug: plan.slug,
      amount: priced.amount,
      currency: priced.currency,
      fallbackFrom: selectedPrice?.fallback?.requested.currency,
    });
    couponContext = {
      couponId: validated.coupon.id,
      code: validated.coupon.code,
      discountAmount: validated.discountAmount,
    };
  }

  // No try/catch around the bound case any more: the guard above is the one
  // site that decides "the provider this buyer is bound to is gone", and it
  // has already run. A second, half-reachable copy of that decision living
  // in a catch block is how the reachable one gets deleted.
  const providerName: BillingProviderName = await pickProvider({
    application: input.application,
    ...(!costsNothing(plan) && { currency: priced.currency }),
    ...(input.country !== undefined && { country: input.country }),
    ...(boundProvider !== null
      ? { preferred: boundProvider as BillingProviderName, bound: true }
      : namedProvider !== undefined && { preferred: namedProvider }),
  });

  // Decided while refusing is still free: a REFUSE here has reserved no
  // coupon or trial slot, written no PENDING row and called no processor.
  const presentation = await resolveCheckoutPresentation({
    application: input.application,
    provider: providerName,
    plan: priced,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    endUserId: input.endUser.id,
    ...(input.mode !== undefined && { requested: input.mode }),
  });

  // Before anything is reserved: a buyer whose last checkout for this plan
  // is already paid at PayPal must not be sold a second subscription.
  if (!isOneTime) {
    await assertNoApprovalInFlight({ application: input.application, endUserId: input.endUser.id, planId: plan.id });
  }

  // Resolved as soon as the provider is known and BEFORE any row is written:
  // whether the discount can actually be charged depends on the provider and
  // the flow, and a checkout that cannot honour the coupon must fail while
  // it still costs nothing. See checkout-discount.ts for what it refuses.
  const discount = couponContext
    ? resolveCheckoutDiscount({ plan: priced, provider: providerName, isOneTime, coupon: couponContext, endUserId: input.endUser.id })
    : null;

  // Same shape, same reason: refuse a trial this checkout cannot honour
  // while refusing is still free. Charging today for a plan the pricing page
  // advertised as a free trial is not a failure mode worth having.
  const trial = resolveCheckoutTrial({ plan: priced, provider: providerName, isOneTime });

  // The row this checkout will upsert, read for its metadata and its status
  // further down (a live provider session must not be stranded, and an
  // entitled row keeps its dates through an upgrade), and, immediately
  // below, for whose subscription it actually is.
  //
  // The provider-switch guard that used to sit here, keyed on this same
  // (application, endUser, plan) and compared AFTER the router had run, is
  // gone, but its KEY is not. It moved into the lookup above, as the second
  // arm of that `OR`, because the two keys protect different things and the
  // subject-scoped one alone let an org checkout rewrite a personal row's
  // provider. Read the comment there before narrowing either arm.
  //
  // It was also doing a job that had nothing to do with providers, and that
  // job is now the guard below rather than a side effect.
  const existing = await prisma.subscription.findUnique({
    where: {
      applicationId_endUserId_planId: {
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        planId: plan.id,
      },
    },
  });

  assertSubjectUnchanged(existing, { planSlug: plan.slug, beneficiaryOrgId: input.beneficiaryOrgId });

  // Take the coupon's slot BEFORE the provider mints the discount, and hold
  // it until the payment settles. `validate` above is advisory only: it
  // counts rows that the payment webhook writes, and that webhook is up to a
  // session-lifetime away, so the ceiling was being enforced against rows
  // that did not exist yet, and five checkouts on a `maxRedemptions: 1`
  // coupon charged five discounts. The reservation is what makes the limit
  // bound the DISCOUNTS rather than the bookkeeping. See coupons.service.ts.
  const reservation =
    couponContext !== null
      ? await couponsService.reserveForCheckout({
          couponId: couponContext.couponId,
          applicationId: input.application.id,
          endUserId: input.endUser.id,
          code: couponContext.code,
          discountAmount: couponContext.discountAmount,
          currency: priced.currency,
          planPriceId: priced.planPriceId,
        })
      : null;

  const provider = await getProviderForApplication(input.application, providerName);
  // Serialised per buyer, see checkout-claim.ts. A one-time purchase binds
  // nobody and carries no trial, so it claims nothing.
  const { effectiveTrial, trialReservationId, claimCreatedRow } = isOneTime
    ? { effectiveTrial: trial, trialReservationId: null, claimCreatedRow: false }
    : await claimCheckout({
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        beneficiaryOrgId: input.beneficiaryOrgId,
        allowWithoutTrial: input.allowWithoutTrial,
        plan,
        priced,
        providerName,
        trial,
        billingConfig,
      });

  const checkoutInput = {
    application: { id: input.application.id, slug: input.application.slug },
    endUser: input.endUser,
    plan: priced,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    // The discount goes to the PROCESSOR, not just onto our own rows. It
    // used to stop at `couponContext` below, so every coupon ever applied
    // charged the buyer full price while we recorded a discount and
    // redeemed the code.
    ...(discount !== null && { discount }),
    // Same seam, same lesson: the trial has to reach the PROCESSOR. It is
    // the provider that runs the clock and converts the trial into a
    // charge, so a trial that stops at our own rows charges the buyer today.
    // `effectiveTrial`, not `trial`: an ineligible repeat trialist who passed
    // `allowWithoutTrial` buys at full price, and the provider must be told
    // that rather than starting a clock we already refused.
    ...(effectiveTrial !== null && { trial: effectiveTrial }),
  };

  let session: IssuedCheckout;
  try {
    // An additional price registers with the provider at its first recurring
    // checkout. A one-time purchase charges an inline amount and needs none.
    const registered = isOneTime
      ? priced
      : await ensurePlanPriceRegistered({ provider, providerName, plan: priced });
    session = await issueProviderCheckout(provider, { ...checkoutInput, plan: registered }, {
      isOneTime,
      embedded: presentation.embedded,
      slug: input.application.slug,
      paymentMode: presentation.paymentMode,
      discountAmount: couponContext?.discountAmount ?? 0,
    });
  } catch (e) {
    // No session means no discount was minted, so the slot goes straight
    // back rather than sitting out its 24-hour expiry, a reservation that
    // outlives the checkout it was for is a denial-of-discount against the
    // next buyer.
    if (reservation) await couponsService.releaseReservation(reservation.reservationId);
    // Same reasoning for the trial slot: no session means no provider-side
    // trial was minted, so the slot goes straight back rather than sitting
    // out its session-lifetime expiry and refusing this buyer's next attempt.
    if (trialReservationId) await releaseTrial(prisma, trialReservationId);
    // Same reasoning for the binding claim (#437): the row exists only to
    // hold this buyer's provider across the window below, and the checkout
    // it was claimed for has just failed. Left behind it would BIND them,
    // an unpaid PENDING row pinning them to a processor they never reached,
    // so their next checkout elsewhere is refused by a sale that never
    // happened. Deleted only when this call created it; an existing row is
    // somebody's real subscription.
    if (claimCreatedRow) {
      await prisma.subscription
        .delete({
          where: {
            applicationId_endUserId_planId: {
              applicationId: input.application.id,
              endUserId: input.endUser.id,
              planId: plan.id,
            },
          },
        })
        .catch(() => {
          // Best-effort. The provider failure is the error worth reporting,
          // and the claim expires from the binder read on the session clock
          // regardless (see CHECKOUT_SESSION_LIFETIME_MS).
        });
    }
    // `audience: 'end-user'`. This is the public checkout surface: the caller
    // is the operator's CUSTOMER. Rethrowing raw gave them `500
    // INTERNAL_ERROR / "share this request id with support"` for somebody
    // else's misconfigured Stripe account, or, when the provider error
    // happened to carry a 4xx `.statusCode`, the operator's key fragment.
    throw providerError({
      provider: providerName,
      operation: 'checkout',
      audience: 'end-user',
      error: e,
    });
  }
  // The reservation becomes findable by (coupon, session) here, which is how
  // the webhook appliers settle it.
  if (reservation) {
    await couponsService.bindReservationToSession(reservation.reservationId, session.sessionId);
  }
  if (trialReservationId) {
    // Two steps for the same reason the coupon reservation needs two: the
    // reservation predates the session id. This is what the confirmation
    // looks the redemption up by.
    await bindTrialToSession(prisma, trialReservationId, session.sessionId);
  }

  // Upsert by (applicationId, endUserId, planId): if the user already started
  // checkout for this same plan and bailed, reuse that PENDING row instead
  // of creating a parallel one.
  //
  // The metadata REMEMBERS the earlier sessions rather than overwriting them.
  // Overwriting stranded any still-live provider session, a Stripe Checkout
  // Session stays completable for ~24h, so a buyer who reopened checkout and
  // then went back and paid on the first tab matched no local row: 200 OK,
  // row still PENDING, no payment, no redemption, no trace of a real sale.
  // See checkout-sessions.ts.
  const subscriptionMetadata = buildCheckoutSessionMetadata({
    previous: existing?.metadata ?? null,
    sessionId: session.sessionId,
    isOneTime,
    provider: providerName,
    openedAt: new Date(),
    coupon: couponContext
      ? {
          couponId: couponContext.couponId,
          discountAmount: couponContext.discountAmount,
          currency: priced.currency.toUpperCase(),
        }
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
      // it one: an ACTIVE subscriber who merely pressed Upgrade, or typed a
      // coupon into the form the account page now shows *existing*
      // subscribers, was downgraded on the spot. PENDING is not an
      // entitling status, so their portal showed them as unsubscribed and
      // every entitlement gate started refusing, without a single provider
      // event having happened. The provider's webhook is what moves a paying
      // subscription between states; this row is only a checkout record.
      //
      // Walking the row back to PENDING restarts its lifecycle, so the
      // previous cancellation's dates go with it. `(applicationId,
      // endUserId, planId)` is unique, so a resubscribe REUSES the cancelled
      // row, and a `cancelAt` left on it survives all the way through to the
      // live subscription, where it makes the account panel show
      // "Cancelling, ends <a past date>", hide the Cancel button, and turn
      // the cancel endpoint into a 200-OK no-op while the provider keeps
      // charging. An ENTITLED row keeps its dates: someone pressing Upgrade
      // mid-period has not withdrawn a cancellation they scheduled.
      ...(isEntitlingStatus(existing?.status)
        ? {}
        : { status: 'PENDING' as const, cancelAt: null, canceledAt: null }),
      ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
      metadata: subscriptionMetadata as never,
    },
  });

  // The redemption is RESERVED at this point, not settled: the coupon also
  // rides on `subscription.metadata.couponBySession`, and `webhooks/apply.ts`
  // confirms the reservation when the provider says the purchase completed.
  // Recording a settled redemption here would be abusable in the other
  // direction, apply a coupon, abandon checkout, and the per-user / global
  // limit is exhausted for legitimate buyers, which is why the reservation
  // expires on its own. See decisions.md 2026-05-19 and 2026-08-02.

  const checkoutSession = await recordIssuedCheckout(session, {
    applicationId: input.application.id,
    endUserId: input.endUser.id,
    subscriptionId: subscription.id,
    provider: providerName,
    embedded: presentation.embedded,
    paymentMode: presentation.paymentMode,
    isOneTime,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    buyerCountry: input.country?.toUpperCase() ?? null,
    buyerCountrySource: input.country === undefined ? null : (input.countrySource ?? null),
    price: { currency: priced.currency, unitAmount: priced.amount },
    discountAmount: couponContext?.discountAmount ?? 0,
    planPriceId: priced.planPriceId,
    plan: { id: plan.id, slug: plan.slug },
    priceFallback: selectedPrice?.fallback ?? null,
  });

  return {
    url: session.url,
    subscription,
    discountAmount: couponContext?.discountAmount ?? 0,
    currency: priced.currency.toUpperCase(),
    unitAmount: priced.amount,
    price: selectedPrice,
    provider: providerName,
    embedded: presentation.embedded,
    checkoutSessionId: checkoutSession.id,
    fellBack: presentation.fellBack,
    paymentMode: presentation.paymentMode,
  };
}

/**
 * A plan that is off sale. An unregistered one cannot be reactivated by
 * flipping `active` (that answers PLAN_NOT_REGISTERED_WITH_PROVIDER), so its
 * fix names registration instead.
 */
function planInactive(applicationId: string, plan: Plan): RekeyError {
  const route = `/api/v1/tenant/applications/${applicationId}/plans/${plan.slug}`;
  const unregistered = plan.registrationStatus === 'PENDING' || plan.registrationStatus === 'FAILED';
  return new RekeyError({
    statusCode: 400,
    code: 'PLAN_INACTIVE',
    message: unregistered
      ? `Plan "${plan.slug}" is not currently available for new sign-ups: it is not registered with the payment provider.`
      : `Plan "${plan.slug}" is not currently available for new sign-ups.`,
    fix: unregistered
      ? `Pick a plan from GET /api/v1/billing/plans, which lists the active ones. The operator can put this one on sale by registering it, which activates it: POST ${route}/register (Panel → Application → Plans → Register). If registration was refused, correct the provider credentials in Panel → Application → Billing → Setup → Providers first.`
      : `Pick a plan from GET /api/v1/billing/plans, which lists the active ones. The operator can reactivate this one in Panel → Application → Plans (/applications/${applicationId}/plans) or with PATCH ${route} and \`{ "active": true }\`.`,
  });
}

