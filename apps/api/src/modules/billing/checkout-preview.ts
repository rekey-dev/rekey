/**
 * What a checkout would do for this buyer, without opening one.
 *
 * The coupon preview, trial eligibility and the provider list all answer ahead
 * of checkout, and an answer made against a different price or provider than
 * the checkout then uses is worse than none. These read the same binding and
 * run the same selection `createCheckoutSession` does.
 */

import type { Application, PlanPrice } from '@prisma/client';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import type { PlanWithDefaultPrice } from '../plans/default-price.js';
import type { BuyerCountry } from './buyer-country.js';
import { bindingAmong, loadBindingCandidates, type BindingCandidate } from './checkout-binding.js';
import { additionalPricesWhere, resolveCheckoutPrice, unavailableCurrencyRule } from './checkout-price-resolution.js';
import type { CheckoutPrice } from './checkout-price.js';
import {
  billingCredentialsService,
  canCharge,
  type BillingProviderName,
  type EnabledProvider,
} from './credentials.service.js';
import { costsNothing } from './free-plan.js';
import { isOneTimePlan } from './plan-kind.js';
import { pickProvider } from './providers/index.js';
import type { PricedPlan } from './providers/types.js';

/** Who would be checking out, and on what terms. */
export interface CheckoutPreviewBuyer {
  application: Application;
  endUserId: string;
  /** The organization the checkout would bill, when it bills one. */
  beneficiaryOrgId?: string | undefined;
  buyer: BuyerCountry | null;
  callerIsSecretKey: boolean;
}

export interface CheckoutPreviewInput extends CheckoutPreviewBuyer {
  plan: PlanWithDefaultPrice;
  /** `currency` as the caller sent it. Refused from a publishable key, as at checkout. */
  requestedCurrency?: string | undefined;
  /** `onUnavailableCurrency` as the caller would send it to checkout. Left out, the Application's default applies. */
  onUnavailableCurrency?: 'fallback' | 'refuse' | undefined;
  /** `provider` as the caller would send it to checkout. The provider the buyer is bound to outranks it. */
  provider?: BillingProviderName | undefined;
  /** Rows already read by `loadCheckoutPreviewRows`, for a caller that previews many plans. */
  rows?: CheckoutPreviewRows | undefined;
}

export interface CheckoutPricePreview {
  /** The plan at the price checkout would charge. */
  priced: PricedPlan;
  /** The selection behind it, or null for a plan with no flat price. */
  price: CheckoutPrice | null;
  /** The provider this buyer is already bound to, which checkout would have to use. */
  boundProvider: BillingProviderName | null;
  /** The provider the caller named, unless checkout would set it aside. */
  namedProvider: BillingProviderName | undefined;
}

/** Everything a preview reads, for any number of plans. */
export interface CheckoutPreviewRows {
  candidates: BindingCandidate[];
  providers: EnabledProvider[];
  pricesByPlan: Map<string, PlanPrice[]>;
}

/**
 * Read once what previewing `plans` for this buyer needs: three queries
 * however many plans there are.
 *
 * @example
 * const rows = await loadCheckoutPreviewRows({ application, endUserId, buyer, callerIsSecretKey: false }, plans);
 * const provider = await previewCheckoutProvider({ application, endUserId, buyer, callerIsSecretKey: false, plan, rows });
 */
export async function loadCheckoutPreviewRows(
  who: CheckoutPreviewBuyer,
  plans: readonly PlanWithDefaultPrice[],
): Promise<CheckoutPreviewRows> {
  const [candidates, providers, prices] = await Promise.all([
    loadBindingCandidates({
      applicationId: who.application.id,
      endUserId: who.endUserId,
      beneficiaryOrgId: who.beneficiaryOrgId,
    }),
    billingCredentialsService.listCheckoutEnabled(who.application.id, who.buyer?.country),
    prisma.planPrice.findMany({ where: additionalPricesWhere(plans) }),
  ]);
  const pricesByPlan = new Map<string, PlanPrice[]>();
  for (const price of prices) {
    pricesByPlan.set(price.planId, [...(pricesByPlan.get(price.planId) ?? []), price]);
  }
  return { candidates, providers, pricesByPlan };
}

/**
 * The price a checkout of `plan` by this buyer would select. Throws what
 * checkout throws for a currency it would refuse.
 *
 * @example
 * const { priced } = await previewCheckoutPrice({
 *   application, plan, endUserId, buyer: { country: 'IN', source: 'declared' }, callerIsSecretKey: true,
 * });
 * priced.currency; // 'INR' when the plan has an INR price a provider can charge
 */
export async function previewCheckoutPrice(input: CheckoutPreviewInput): Promise<CheckoutPricePreview> {
  const { application, plan } = input;
  const rows = input.rows ?? (await loadCheckoutPreviewRows(input, [plan]));
  const bound = isOneTimePlan(plan)
    ? null
    : bindingAmong(rows.candidates, {
        endUserId: input.endUserId,
        beneficiaryOrgId: input.beneficiaryOrgId,
        planId: plan.id,
      });
  const boundProvider = (bound?.provider ?? null) as BillingProviderName | null;
  const billingConfig = BillingConfigSchema.parse(application.billingConfig);
  const { priced, price, provider } = await resolveCheckoutPrice({
    applicationId: application.id,
    plan,
    localPrices: billingConfig.localPrices,
    unpricedCurrency: billingConfig.reportingCurrency,
    callerIsSecretKey: input.callerIsSecretKey,
    requestedCurrency: input.requestedCurrency,
    onUnavailableCurrency: unavailableCurrencyRule(input.onUnavailableCurrency, billingConfig),
    country: input.buyer?.country,
    countrySource: input.buyer?.source,
    bound,
    boundProvider: boundProvider ?? undefined,
    namedProvider: input.provider,
    loaded: { prices: rows.pricesByPlan.get(plan.id) ?? [], providers: rows.providers },
  });
  return { priced, price, boundProvider, namedProvider: boundProvider === null ? provider : undefined };
}

/**
 * The provider a checkout of `plan` by this buyer would be sent to: the one
 * they are bound to, else the one they name, else the one routing picks for
 * the price selected. Throws what checkout throws when no provider can take it.
 *
 * @example
 * const provider = await previewCheckoutProvider({
 *   application, plan, endUserId, buyer: null, callerIsSecretKey: false,
 * }); // 'razorpay' for a plan whose selected price only Razorpay can charge
 */
export async function previewCheckoutProvider(input: CheckoutPreviewInput): Promise<BillingProviderName> {
  const rows = input.rows ?? (await loadCheckoutPreviewRows(input, [input.plan]));
  const { priced, boundProvider, namedProvider } = await previewCheckoutPrice({ ...input, rows });
  return pickProvider({
    application: input.application,
    configured: rows.providers,
    ...(!costsNothing(input.plan) && { currency: priced.currency }),
    ...(input.buyer !== null && { country: input.buyer.country }),
    ...(boundProvider !== null
      ? { preferred: boundProvider, bound: true }
      : namedProvider !== undefined && { preferred: namedProvider }),
  });
}

/** One plan's providers as a checkout by this caller would treat them. */
export interface PlanProviders {
  /** The providers a checkout of the plan accepts when named, in routing order. */
  accepted: EnabledProvider[];
  /** The provider a checkout that names none is sent to, or null when none can take it. */
  routed: BillingProviderName | null;
}

/**
 * Which of `configured` a checkout of `plan` accepts, and where one that names
 * no provider goes. Each provider is judged at the price the checkout would
 * select if it were named, so a provider that can only charge a local price
 * this buyer is not offered is left out.
 *
 * No buyer is known here (the provider list is public), so no binding applies.
 *
 * @example
 * const { accepted, routed } = await planProviders({ application, plan, buyer, callerIsSecretKey: false, configured });
 * routed; // 'razorpay' for a buyer in India when the plan has an INR price only Razorpay charges
 */
export async function planProviders(args: {
  application: Application;
  plan: PlanWithDefaultPrice;
  buyer: BuyerCountry | null;
  callerIsSecretKey: boolean;
  configured: EnabledProvider[];
}): Promise<PlanProviders> {
  const { application, plan, configured } = args;
  if (costsNothing(plan)) return { accepted: configured, routed: configured[0]?.provider ?? null };
  const loaded = {
    prices: await prisma.planPrice.findMany({ where: additionalPricesWhere([plan]) }),
    providers: configured,
  };
  const billingConfig = BillingConfigSchema.parse(application.billingConfig);
  const priceFor = async (provider?: BillingProviderName): Promise<PricedPlan> => {
    const { priced } = await resolveCheckoutPrice({
      applicationId: application.id,
      plan,
      localPrices: billingConfig.localPrices,
      unpricedCurrency: billingConfig.reportingCurrency,
      callerIsSecretKey: args.callerIsSecretKey,
      // No currency is named here, so the rule for a named one is never read.
      onUnavailableCurrency: 'fallback',
      country: args.buyer?.country,
      countrySource: args.buyer?.source,
      bound: null,
      namedProvider: provider,
      loaded,
    });
    return priced;
  };
  const named = await Promise.all(configured.map((provider) => priceFor(provider.provider)));
  const unnamed = await priceFor();
  return {
    accepted: configured.filter((provider, i) => canCharge(provider, named[i]!.currency)),
    routed: configured.find((provider) => canCharge(provider, unnamed.currency))?.provider ?? null,
  };
}
