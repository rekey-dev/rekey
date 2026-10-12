/**
 * Reads what `selectCheckoutPrice` needs and returns the price selected: for
 * one checkout, or for every plan on a page. The decision itself is in
 * checkout-price.ts, and both entry points here reach it through
 * `decideCheckoutPrice`, so they cannot answer differently.
 */

import type { PlanLocalPrices, PlanPrice } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import type { PlanWithDefaultPrice } from '../plans/default-price.js';
import type { BuyerCountry, BuyerCountrySource } from './buyer-country.js';
import { bindingAmong, loadBindingCandidates } from './checkout-binding.js';
import {
  BoundCurrencyUnchargeableError,
  selectCheckoutPrice,
  type CheckoutPrice,
  type LocalPricesRule,
} from './checkout-price.js';
import {
  billingCredentialsService,
  canCharge,
  type BillingProviderName,
  type EnabledProvider,
} from './credentials.service.js';
import { isOneTimePlan } from './plan-kind.js';
import { pricedPlan } from './priced-plan.js';
import type { PricedPlan } from './providers/types.js';

/** The subscription row that binds this buyer to a provider, if one does. */
export interface BoundSubscription {
  id: string;
  status: string;
  provider?: string | null;
  providerSubId?: string | null;
  currency: string | null;
}

/**
 * The currency a bound buyer already pays in, or null when they pay in none
 * yet.
 *
 * Only the subscription's own price binds. A row with no price recorded binds
 * the provider and no currency: reading its plan's default price here would
 * hold the buyer to a currency nobody recorded them paying in.
 *
 * An unpaid checkout binds the provider and nothing else. If it bound the
 * currency too, a buyer could open a checkout on a plan priced in a cheap
 * currency, never pay it, and carry that currency to every other plan
 * without their country ever being believed.
 */
function boundCurrencyOf(bound: BoundSubscription): string | null {
  const unpaid = bound.status === 'PENDING' && (bound.providerSubId ?? null) === null;
  return unpaid ? null : bound.currency;
}

/**
 * The rule a plan's checkout follows for local prices: the stricter of what
 * the plan says and what the Application says. A plan can only narrow it.
 *
 * @example
 * localPricesRule('TRUSTED', 'any'); // 'trusted': a credit pack ignores a country a browser states
 * localPricesRule('INHERIT', 'any'); // 'any'
 * localPricesRule('OFF', 'trusted'); // 'off'
 */
export function localPricesRule(plan: PlanLocalPrices, application: 'trusted' | 'any'): LocalPricesRule {
  if (plan === 'OFF') return 'off';
  return plan === 'TRUSTED' ? 'trusted' : application;
}

/**
 * What a checkout does with a named currency nobody can charge: what the
 * request says, else the Application's default. A request always wins.
 *
 * @example
 * unavailableCurrencyRule(undefined, { onUnavailableCurrency: 'refuse' }); // 'refuse'
 * unavailableCurrencyRule('fallback', { onUnavailableCurrency: 'refuse' }); // 'fallback'
 */
export function unavailableCurrencyRule(
  requested: 'fallback' | 'refuse' | undefined,
  billingConfig: { onUnavailableCurrency: 'fallback' | 'refuse' },
): 'fallback' | 'refuse' {
  return requested ?? billingConfig.onUnavailableCurrency;
}

export interface PriceDecisionInput {
  plan: PlanWithDefaultPrice;
  /** The plan's live prices other than its default. */
  prices: readonly PlanPrice[];
  /** The providers a checkout for this buyer could be routed to. */
  providers: readonly EnabledProvider[];
  /** The Application's `billingConfig.localPrices`. The plan's own setting can only narrow it. */
  localPrices: 'trusted' | 'any';
  callerIsSecretKey: boolean;
  requestedCurrency?: string | undefined;
  /** The request's own value, else the Application's `billingConfig.onUnavailableCurrency`: see `unavailableCurrencyRule`. */
  onUnavailableCurrency: 'fallback' | 'refuse';
  buyer: BuyerCountry | null;
  bound: BoundSubscription | null;
  /** The provider the buyer is bound to. Its currencies alone decide what is chargeable. */
  boundProvider?: BillingProviderName | undefined;
  /** The provider the caller named. */
  namedProvider?: BillingProviderName | undefined;
}

export interface PriceDecision {
  /** The price selected, or null for a plan with no flat price. */
  price: CheckoutPrice | null;
  /**
   * The provider the checkout must use: the bound one, or the one the caller
   * named. Undefined when neither applies, and when a browser named a provider
   * that cannot charge the price selected.
   */
  provider: BillingProviderName | undefined;
}

/**
 * The price one buyer is charged for one plan, from facts already read. Every
 * caller that needs a price goes through here.
 *
 * A provider named with the secret key decides what is chargeable, as the
 * bound one does. A provider named from a browser does not: naming the one
 * provider that cannot charge a local price would otherwise be a way to pick
 * the default price whenever it is the cheaper of the two. The price is
 * selected as if none were named, and the name is kept only if that provider
 * can charge it.
 *
 * @example
 * const { price } = decideCheckoutPrice({
 *   plan, prices, providers, localPrices: 'trusted', onUnavailableCurrency: 'fallback', callerIsSecretKey: true,
 *   buyer: { country: 'IN', source: 'declared' }, bound: null,
 * });
 * price?.reason; // 'country' when the plan has an INR price a provider can charge
 */
export function decideCheckoutPrice(input: PriceDecisionInput): PriceDecision {
  const { plan, providers } = input;
  const serverNamed = input.callerIsSecretKey ? input.namedProvider : undefined;
  const only = input.boundProvider ?? serverNamed;
  const named = input.boundProvider ?? input.namedProvider;

  const defaultPrice = plan.defaultPrice;
  if (defaultPrice === null) {
    if (input.requestedCurrency !== undefined) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_PLAN_CURRENCY_UNAVAILABLE',
        message: `Plan "${plan.slug}" has no flat price, so it has none in ${input.requestedCurrency.toUpperCase()}.`,
        fix: 'Omit `currency` for this plan.',
      });
    }
    return { price: null, provider: named };
  }

  const onlyRow = only === undefined ? undefined : providers.find((p) => p.provider === only);
  // The selection never asks about the default price. `pickProvider` runs
  // next on the currency selected and has the specific refusal for each case:
  // no provider at all, a named one that is not enabled, or none that can
  // charge it, with the panel path to repair it.
  const chargeable = (currency: string): boolean => {
    if (only !== undefined) return onlyRow !== undefined && canCharge(onlyRow, currency);
    return providers.some((p) => canCharge(p, currency));
  };

  const price = selectCheckoutPrice({
    planSlug: plan.slug,
    defaultPrice,
    prices: input.prices,
    buyer: input.buyer,
    requestedCurrency: input.requestedCurrency,
    callerIsSecretKey: input.callerIsSecretKey,
    localPrices: localPricesRule(plan.localPrices, input.localPrices),
    onUnavailableCurrency: input.onUnavailableCurrency,
    boundCurrency: input.bound === null ? null : boundCurrencyOf(input.bound),
    onlyProvider: only,
    chargeable,
  });

  const browserNamed = only === undefined ? input.namedProvider : undefined;
  const browserNamedRow = browserNamed === undefined ? undefined : providers.find((p) => p.provider === browserNamed);
  const setAside = browserNamedRow !== undefined && !canCharge(browserNamedRow, price.currency);
  return { price, provider: setAside ? undefined : named };
}

/**
 * The filter for plans' live prices other than their defaults: the rows the
 * selection chooses among.
 *
 * @example
 * const prices = await prisma.planPrice.findMany({ where: additionalPricesWhere([plan]) });
 */
export function additionalPricesWhere(plans: readonly PlanWithDefaultPrice[]): {
  planId: { in: string[] };
  archivedAt: null;
  id: { notIn: string[] };
} {
  const priced = plans.filter((plan) => plan.defaultPrice !== null);
  return {
    planId: { in: priced.map((plan) => plan.id) },
    archivedAt: null,
    id: { notIn: priced.map((plan) => plan.defaultPrice!.id) },
  };
}

export interface ResolvedCheckoutPrice {
  /** The plan at the price selected. */
  priced: PricedPlan;
  /** The selection, or null for a plan with no flat price. */
  price: CheckoutPrice | null;
  /** The provider the checkout must use, when one is decided. See `PriceDecision.provider`. */
  provider: BillingProviderName | undefined;
}

/** The rows `resolveCheckoutPrice` reads: the plan's live prices other than its default, and the providers in routing order for the buyer's country. */
export interface CheckoutPriceInputs {
  prices: readonly PlanPrice[];
  providers: readonly EnabledProvider[];
}

/**
 * Select the price this checkout is charged at and return the plan at it.
 *
 * @example
 * const { priced, price } = await resolveCheckoutPrice({
 *   applicationId, plan, localPrices: 'trusted', onUnavailableCurrency: 'fallback', unpricedCurrency: 'USD',
 *   callerIsSecretKey: true, country: 'IN', countrySource: 'declared', bound: null,
 * });
 * priced.currency; // 'INR' when the plan has an INR price a provider can charge
 */
export async function resolveCheckoutPrice(args: {
  applicationId: string;
  plan: PlanWithDefaultPrice;
  localPrices: 'trusted' | 'any';
  /** The currency a plan with no flat price is sent to a provider in: the Application's reporting currency. */
  unpricedCurrency: string;
  callerIsSecretKey: boolean;
  requestedCurrency?: string | undefined;
  /** The request's own value, else the Application's default: see `unavailableCurrencyRule`. */
  onUnavailableCurrency: 'fallback' | 'refuse';
  country?: string | undefined;
  countrySource?: BuyerCountrySource | undefined;
  bound: BoundSubscription | null;
  boundProvider?: BillingProviderName | undefined;
  namedProvider?: BillingProviderName | undefined;
  /** What this would otherwise read, for a caller that resolves many plans at once. */
  loaded?: CheckoutPriceInputs | undefined;
}): Promise<ResolvedCheckoutPrice> {
  const { plan } = args;
  const hasPrices = plan.defaultPrice !== null;
  const [prices, providers] =
    args.loaded !== undefined
      ? [hasPrices ? args.loaded.prices : [], args.loaded.providers]
      : await Promise.all([
          hasPrices ? prisma.planPrice.findMany({ where: additionalPricesWhere([plan]) }) : [],
          billingCredentialsService.listCheckoutEnabled(args.applicationId, args.country),
        ]);

  const { price, provider } = decideCheckoutPrice({
    plan,
    prices,
    providers,
    localPrices: args.localPrices,
    callerIsSecretKey: args.callerIsSecretKey,
    requestedCurrency: args.requestedCurrency,
    onUnavailableCurrency: args.onUnavailableCurrency,
    buyer: args.country === undefined ? null : { country: args.country, source: args.countrySource ?? 'hint' },
    bound: args.bound,
    boundProvider: args.boundProvider,
    namedProvider: args.namedProvider,
  });
  const row = price === null ? null : (prices.find((candidate) => candidate.id === price.planPriceId) ?? null);
  return { priced: pricedPlan(plan, row, args.unpricedCurrency), price, provider };
}

/** Who a page of plans is being priced for. */
export interface PlanPriceContext {
  buyer: BuyerCountry | null;
  callerIsSecretKey: boolean;
  localPrices: 'trusted' | 'any';
  /** The signed-in buyer, when the request carries their token. */
  endUserId?: string | undefined;
  /** The organization a checkout by this buyer would bill, in an org-billed Application. */
  beneficiaryOrgId?: string | undefined;
  /** The Application's reporting currency, shown as the currency of a plan with no flat price. */
  unpricedCurrency?: string | undefined;
}

/** The price shown to one buyer for one plan. */
export interface PlanPriceSelection {
  price: CheckoutPrice;
  /**
   * False when a checkout by this buyer would be refused whatever they do:
   * the provider they pay through can no longer charge the currency they pay
   * in. `price` is then the price they are bound to, not one they can buy at.
   */
  buyerCanCheckOut: boolean;
}

/**
 * The price each plan's checkout would select for this buyer, keyed by plan
 * id. A plan with no flat price has no entry. One provider read for the page,
 * and one binding read when a buyer is signed in.
 *
 * A buyer checkout would refuse over their bound currency still gets an
 * entry: one such subscriber must not take the whole page down with them.
 *
 * @example
 * const selected = await resolvePlanPrices(applicationId, plans, {
 *   buyer: { country: 'IN', source: 'vouched' }, callerIsSecretKey: false, localPrices: 'trusted',
 * });
 * selected.get(plan.id)?.price.currency; // 'INR'
 */
export async function resolvePlanPrices(
  applicationId: string,
  plans: readonly PlanWithDefaultPrice[],
  context: PlanPriceContext,
  /** Each plan's live prices other than its default, when the caller holds them already. */
  additionalByPlan?: ReadonlyMap<string, readonly PlanPrice[]>,
): Promise<Map<string, PlanPriceSelection>> {
  const out = new Map<string, PlanPriceSelection>();
  if (plans.length === 0) return out;

  // With no buyer and nobody signed in only the default price can be
  // selected, and it is never ruled out, so the providers do not matter.
  const anonymous = context.buyer === null && context.endUserId === undefined;
  const { endUserId, beneficiaryOrgId } = context;
  const [providers, additional, candidates] = await Promise.all([
    anonymous ? [] : billingCredentialsService.listCheckoutEnabled(applicationId, context.buyer?.country),
    additionalByPlan ?? prisma.planPrice.findMany({ where: additionalPricesWhere(plans) }).then(groupByPlan),
    endUserId === undefined || plans.every(isOneTimePlan)
      ? []
      : loadBindingCandidates({ applicationId, endUserId, beneficiaryOrgId }),
  ]);

  for (const plan of plans) {
    const bound =
      endUserId === undefined || isOneTimePlan(plan)
        ? null
        : bindingAmong(candidates, { endUserId, beneficiaryOrgId, planId: plan.id });
    const boundProvider = (bound?.provider ?? null) as BillingProviderName | null;
    try {
      const { price } = decideCheckoutPrice({
        plan,
        prices: additional.get(plan.id) ?? [],
        providers,
        localPrices: context.localPrices,
        // A catalogue names no currency, so the rule for a named one is never read.
        onUnavailableCurrency: 'fallback',
        callerIsSecretKey: context.callerIsSecretKey,
        buyer: context.buyer,
        bound,
        boundProvider: boundProvider ?? undefined,
      });
      if (price !== null) out.set(plan.id, { price, buyerCanCheckOut: true });
    } catch (err) {
      if (!(err instanceof BoundCurrencyUnchargeableError)) throw err;
      out.set(plan.id, { price: { ...err.bound, reason: 'bound', fallback: null }, buyerCanCheckOut: false });
    }
  }
  return out;
}

function groupByPlan(rows: readonly PlanPrice[]): Map<string, PlanPrice[]> {
  const byPlan = new Map<string, PlanPrice[]>();
  for (const row of rows) byPlan.set(row.planId, [...(byPlan.get(row.planId) ?? []), row]);
  return byPlan;
}
