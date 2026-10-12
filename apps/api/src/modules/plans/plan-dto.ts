/**
 * One serialiser for plan lists, told who is reading.
 *
 * The operator list and the public catalogue both answer "can a buyer check
 * out on this plan", from the same `planCheckoutReadiness` pass, so the two
 * cannot disagree about whether a plan is buyable. What differs is how much of
 * the answer each audience gets:
 *
 *   - `operator`: `checkout: { ready, blockers }`. Each blocker names the
 *     provider that refuses, its error code and the repair, which is what an
 *     operator needs to fix the plan.
 *   - `public`: `checkout: { ready }` and nothing else. A buyer has no repair
 *     to make, and a blocker spells out configuration (which providers are
 *     connected, which of them lack a price for this plan, trial support) that
 *     a publishable key must not read. The boolean is enough for a pricing page
 *     to hide a plan that would fail at checkout.
 *
 * Both audiences get `prices`, every price the plan sells at with the default
 * first, and `price`, the one this caller's buyer would be charged. `price`
 * comes from `resolvePlanPrices`, which decides with the function checkout
 * uses.
 *
 * Each audience's plan is built field by field, never by spreading the row.
 * A column added to `plans` reaches nobody until it is named here, and the
 * public plan names no operator configuration: no provider ids, no
 * registration state, no `metadata`.
 *
 * Batched: one credential read and one price read for the whole page,
 * whatever its size, and for an operator two grouped reads of who is on the
 * prices. The public route is hit on every pricing page load, so
 * this must not grow with the number of plans (pinned by a query-count test).
 */

import type { PlanPrice } from '@prisma/client';
import {
  formatMoney,
  type PlanDto,
  type PriceFallbackDto,
  type PublicPlanDto,
  type ResolvedPriceDto,
} from '@rekey.dev/shared-types';
import type { CheckoutPrice } from '../billing/checkout-price.js';
import { resolvePlanPrices, type PlanPriceContext } from '../billing/checkout-price-resolution.js';
import { malformedPlanCurrency, withDefaultPrices, type PlanWithDefaultPrice } from './default-price.js';
import { planCheckoutReadiness, type PlanReadiness } from './plan-readiness.js';
import { planPricesService, toPlanPriceDto, toPublicPlanPriceDto } from './plan-prices.service.js';
import { NO_PRICE_USAGE, priceUsageFor, type PriceUsage } from './price-usage.js';
import type { Plan } from '@prisma/client';

export type PlanAudience = 'public' | 'operator';

/** An operator's plan as it leaves the API. Dates are still `Date`s: the reply serialiser writes them. */
export type OperatorPlanBody = Omit<PlanDto, 'createdAt' | 'updatedAt' | 'checkout' | 'metadata'> & {
  createdAt: Date;
  updatedAt: Date;
  metadata: Plan['metadata'];
};
export type PlanWithPrices = OperatorPlanBody;
export type OperatorPlan = OperatorPlanBody & { checkout: PlanReadiness };
export type PublicPlan = PublicPlanDto;

const READY: PlanReadiness = { ready: true, blockers: [] };

/**
 * An operator reading their own plans is no buyer: no country, nobody signed
 * in. The price resolved for them is each plan's default.
 */
const NO_BUYER: PlanPriceContext = { buyer: null, callerIsSecretKey: true, localPrices: 'trusted' };

function defaultFirst(plan: PlanWithDefaultPrice, prices: readonly PlanPrice[]): PlanPrice[] {
  return [...prices].sort(
    (a, b) =>
      Number(b.id === plan.defaultPriceId) - Number(a.id === plan.defaultPriceId) || a.currency.localeCompare(b.currency),
  );
}

const NO_USAGE: ReadonlyMap<string, PriceUsage> = new Map();

function priceIdsOf(pricesByPlan: ReadonlyMap<string, PlanPrice[]>): string[] {
  return [...pricesByPlan.values()].flatMap((prices) => prices.map((price) => price.id));
}

function additionalOnly(
  plans: readonly PlanWithDefaultPrice[],
  pricesByPlan: ReadonlyMap<string, PlanPrice[]>,
): Map<string, PlanPrice[]> {
  return new Map(
    plans.map((plan) => [plan.id, (pricesByPlan.get(plan.id) ?? []).filter((price) => price.id !== plan.defaultPriceId)]),
  );
}

/**
 * The selected price in its wire shape, or null for a plan with no flat price.
 *
 * @example
 * toResolvedPriceDto(selected); // { id: 'pp_1', currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'country', requestedCurrency: null }
 */
export function toResolvedPriceDto(selected: CheckoutPrice | null | undefined): ResolvedPriceDto | null {
  if (selected === null || selected === undefined) return null;
  return {
    id: selected.planPriceId,
    currency: selected.currency,
    amount: selected.amount,
    formatted: formatMoney(selected.amount, selected.currency),
    isDefault: selected.isDefault,
    reason: selected.reason,
    requestedCurrency: selected.fallback?.requested.currency.toUpperCase() ?? null,
  };
}

/**
 * What a checkout tells its caller when it charges the default price in place
 * of the one selected, or null when it charges the one selected.
 *
 * @example
 * toPriceFallbackDto(selected)?.requested.formatted; // '₹1,499.00'
 */
export function toPriceFallbackDto(selected: CheckoutPrice | null): PriceFallbackDto | null {
  if (selected === null || selected.fallback === null) return null;
  const side = (price: { planPriceId: string; currency: string; amount: number }) => ({
    id: price.planPriceId,
    currency: price.currency,
    amount: price.amount,
    formatted: formatMoney(price.amount, price.currency),
  });
  return { requested: side(selected.fallback.requested), charged: side(selected), reason: selected.fallback.reason };
}

/** The fields both audiences get. Every one is named: nothing is spread from the row. */
function commonFields(plan: PlanWithDefaultPrice, price: ResolvedPriceDto | null) {
  return {
    id: plan.id,
    slug: plan.slug,
    name: plan.name,
    kind: plan.kind,
    interval: plan.interval,
    isFree: plan.isFree,
    trialDays: plan.trialDays,
    licenseKind: plan.licenseKind,
    licenseSeatsAllowed: plan.licenseSeatsAllowed,
    licenseDurationDays: plan.licenseDurationDays,
    meterSlug: plan.meterSlug,
    creditsAmount: plan.creditsAmount,
    price,
  };
}

function operatorPlan(
  plan: PlanWithDefaultPrice,
  prices: readonly PlanPrice[],
  price: ResolvedPriceDto | null,
  usage: ReadonlyMap<string, PriceUsage>,
): OperatorPlanBody {
  return {
    ...commonFields(plan, price),
    applicationId: plan.applicationId,
    prices: prices.map((row) => toPlanPriceDto(row, plan, usage.get(row.id) ?? NO_PRICE_USAGE)),
    defaultPriceId: plan.defaultPriceId,
    localPrices: plan.localPrices,
    active: plan.active,
    registrationStatus: plan.registrationStatus,
    registrationError: plan.registrationError,
    metadata: plan.metadata,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function publicPlan(
  plan: PlanWithDefaultPrice,
  prices: readonly PlanPrice[],
  price: ResolvedPriceDto | null,
  ready: boolean,
): PublicPlan {
  return {
    ...commonFields(plan, price),
    prices: prices.map((row) => toPublicPlanPriceDto(row, plan)),
    checkout: { ready },
  };
}

/**
 * A plan whose stored currency is not a currency cannot be given a price row,
 * so nothing can charge it. Said to the operator as a blocker; the public
 * catalogue reads it as not ready.
 */
function withCurrencyProblem(plan: PlanWithDefaultPrice, readiness: PlanReadiness): PlanReadiness {
  const malformed = malformedPlanCurrency(plan);
  if (malformed === null) return readiness;
  return {
    ready: false,
    blockers: [
      {
        provider: null,
        code: 'PLAN_CURRENCY_INVALID',
        message: `Plan "${plan.slug}" is stored with the currency "${malformed}", which is not a three-letter ISO 4217 code, so it has no price a buyer can be charged.`,
        fix: `Set the plan's price again with PATCH /api/v1/tenant/applications/${plan.applicationId}/plans/${plan.slug} and a body such as {"price": {"currency": "USD", "amount": 2000}} (Panel → Application → Plans → Edit).`,
      },
      ...readiness.blockers,
    ],
  };
}

/**
 * One plan with its prices, for an operator route that returns a single plan.
 *
 * @example
 * return { success: true, data: await withPrices(plan) };
 */
export async function withPrices(plan: Plan): Promise<PlanWithPrices> {
  const [priced] = await withPricesForAll([plan]);
  return priced!;
}

/**
 * A page of plans with their prices, for an operator route. One price query.
 *
 * @example
 * return { success: true, data: paged(await withPricesForAll(items), total, take, skip) };
 */
export async function withPricesForAll(rows: Plan[]): Promise<PlanWithPrices[]> {
  const plans = await withDefaultPrices(rows);
  const pricesByPlan = await planPricesService.listForPlans(plans.map((plan) => plan.id));
  const applicationId = plans[0]?.applicationId ?? '';
  const [selected, usage] = await Promise.all([
    resolvePlanPrices(applicationId, plans, NO_BUYER, additionalOnly(plans, pricesByPlan)),
    priceUsageFor(priceIdsOf(pricesByPlan)),
  ]);
  return plans.map((plan) =>
    operatorPlan(plan, defaultFirst(plan, pricesByPlan.get(plan.id) ?? []), toResolvedPriceDto(selected.get(plan.id)?.price), usage),
  );
}

export async function serializePlans(applicationId: string, plans: Plan[], audience: 'operator'): Promise<OperatorPlan[]>;
export async function serializePlans(
  applicationId: string,
  plans: Plan[],
  audience: 'public',
  context: PlanPriceContext,
): Promise<PublicPlan[]>;
export async function serializePlans(
  applicationId: string,
  rows: Plan[],
  audience: PlanAudience,
  context: PlanPriceContext = NO_BUYER,
): Promise<Array<OperatorPlan | PublicPlan>> {
  const plans = await withDefaultPrices(rows);
  const pricesByPlan = await planPricesService.listForPlans(plans.map((plan) => plan.id));
  const additional = additionalOnly(plans, pricesByPlan);
  // Who is on each price is the operator's to know, and is not read for a pricing page.
  const [readiness, selected, usage] = await Promise.all([
    planCheckoutReadiness(applicationId, plans, additional),
    resolvePlanPrices(applicationId, plans, context, additional),
    audience === 'operator' ? priceUsageFor(priceIdsOf(pricesByPlan)) : NO_USAGE,
  ]);
  return plans.map((plan) => {
    const checkout = withCurrencyProblem(plan, readiness.get(plan.id) ?? READY);
    const prices = defaultFirst(plan, pricesByPlan.get(plan.id) ?? []);
    const selection = selected.get(plan.id);
    const price = toResolvedPriceDto(selection?.price);
    return audience === 'operator'
      ? { ...operatorPlan(plan, prices, price, usage), checkout }
      : publicPlan(plan, prices, price, checkout.ready && selection?.buyerCanCheckOut !== false);
  });
}
