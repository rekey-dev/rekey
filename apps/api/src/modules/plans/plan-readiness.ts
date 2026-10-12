/**
 * Is this plan actually buyable?
 *
 * A plan carries no evidence of its own brokenness. It is listed, it is
 * `active`, the pricing page renders a Buy button, and a plan that no provider
 * will ever accept looks exactly like one that works. The first thing that
 * disagrees is a buyer clicking Buy and getting a 409, which is the worst
 * possible place to discover it and the only place we discovered it before
 * this module existed.
 *
 * The trap is an ordering one. Plans register with the provider AT CREATION
 * TIME, so a plan created before its Application had credentials has no price
 * behind it, and configuring the provider afterwards does not reach back and
 * fix it. Nothing about that is exotic: over MCP, creating an application and a
 * plan is two quick calls, while pasting a provider secret is a trip to another
 * surface entirely, so plans-then-provider is the NATURAL order and the broken
 * one. It cost a day of debugging a checkout that was never going to work.
 *
 * This answers the question ahead of the buyer, per provider, because that is
 * the granularity the failure has: checkout geo-routes, so a plan can be fine
 * through PayPal and dead through Stripe, and the buyers who lose are only the
 * ones the router sent to Stripe. Collapsing that to one boolean would report
 * a half-broken plan as working for whoever tested with the lucky country.
 *
 * It is a REPORT, never a gate. `createCheckoutSession` still refuses on its
 * own, and nothing here can make a checkout fail that would otherwise have
 * succeeded. That asymmetry is what lets a module stay silent (see
 * `planCheckoutBlocker`): the cost of a missed warning is a refusal the buyer
 * would have hit anyway, and the cost of a false warning is an operator
 * chasing a plan that was fine.
 */

import { costsNothing } from '../billing/free-plan.js';
import type { Plan, PlanPrice } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { billingCredentialsService, canCharge } from '../billing/credentials.service.js';
import type { BillingProviderName } from '../billing/credentials.service.js';
import type { PlanCheckoutBlocker } from '../billing/providers/module-types.js';
import { getModule } from '../billing/providers/registry.js';

/** One reason one provider would refuse, tagged with which provider. */
export interface PlanBlocker extends PlanCheckoutBlocker {
  provider: BillingProviderName | null;
}

export interface PlanReadiness {
  ready: boolean;
  blockers: PlanBlocker[];
}

/**
 * Readiness for many plans in one pass, keyed by plan id.
 *
 * Batched because the caller is always a list view and the credential lookup
 * is per Application, not per plan. Blocker evaluation itself is pure and
 * touches neither the database nor the provider.
 *
 * `pricesByPlan` is each plan's additional prices. A caller that already
 * holds them passes them; otherwise they are read here, once for all plans.
 */
/**
 * What readiness reads of a plan: the plan, and the currency of its default
 * price (null for a plan with no flat price).
 */
export type ReadinessPlan = Omit<Plan, 'amount' | 'currency' | 'pricePerUnitCents'> & {
  defaultPrice: { currency: string } | null;
};

export async function planCheckoutReadiness(
  applicationId: string,
  plans: readonly ReadinessPlan[],
  pricesByPlan?: ReadonlyMap<string, ReadonlyArray<Pick<PlanPrice, 'currency'>>>,
): Promise<Map<string, PlanReadiness>> {
  const out = new Map<string, PlanReadiness>();
  if (plans.length === 0) return out;

  const enabled = await billingCredentialsService.listEnabled(applicationId);

  // No provider at all is a different fact from a plan the provider refused,
  // and it needs a different repair, so it gets its own blocker rather than
  // being reported once per provider that does not exist.
  if (enabled.length === 0) {
    const blocker: PlanBlocker = {
      provider: null,
      code: 'NO_BILLING_PROVIDER',
      message: 'This Application has no billing provider configured, so nothing can be bought.',
      fix: 'Connect Stripe, PayPal or Razorpay in Panel → Application → Billing → Setup → Providers. Plans created before that will need registering afterwards.',
    };
    for (const plan of plans) out.set(plan.id, { ready: false, blockers: [blocker] });
    return out;
  }

  // Only providers a buyer can be routed to decide readiness, the set
  // `listCheckoutEnabled` gives the geo router. An inbound-only module (the
  // external billing system) refuses every plan by design, so counting it next
  // to a real provider reported every plan as unbuyable while checkout through
  // that provider worked. When nothing enabled can host a checkout, every
  // enabled module is evaluated, so the inbound-only one says why.
  const routable = enabled.filter(({ provider }) => getModule(provider)?.capabilities.checkout !== false);
  const judged = routable.length > 0 ? routable : enabled;

  const additional = pricesByPlan ?? (await additionalCurrencies(plans));

  for (const plan of plans) {
    const blockers: PlanBlocker[] = [];
    const priced = !costsNothing(plan);
    const defaultCurrency = plan.defaultPrice?.currency.toUpperCase() ?? null;
    const currencies = [
      ...(defaultCurrency === null ? [] : [defaultCurrency]),
      ...(additional.get(plan.id) ?? []).map((price) => price.currency),
    ];
    // The default price is the one every buyer without a local price pays,
    // so it must be chargeable: a chargeable local price does not make up for
    // a default nobody can be charged.
    if (defaultCurrency !== null && routable.length > 0 && !routable.some((p) => canCharge(p, defaultCurrency))) {
      const currency = defaultCurrency;
      blockers.push({
        provider: null,
        code: 'PLAN_CURRENCY_UNSUPPORTED',
        message:
          currencies.length === 1
            ? `No enabled provider is set up to charge ${currency}, the currency of this plan, so its checkout is refused.`
            : `No enabled provider is set up to charge ${currency}, this plan's default price, so a buyer without a local price is refused.`,
        fix: `Add ${currency} to a provider's currencies in Panel → Application → Billing → Setup → Providers → Edit, or price the plan in a currency a provider there can charge.`,
      });
    }
    for (const candidate of judged) {
      const { provider } = candidate;
      // A provider that cannot charge any of this plan's prices is never
      // routed it, so what it would make of the plan does not matter.
      if (priced && currencies.length > 0 && !currencies.some((c) => canCharge(candidate, c))) continue;
      const module = getModule(provider);
      const blocker = module?.planCheckoutBlocker?.(plan);
      if (blocker) blockers.push({ provider, ...blocker });

      // A trial is only honoured by a provider that declares it can express
      // one. `resolveCheckoutTrial` refuses the checkout outright otherwise,
      // correctly, since charging today for something advertised as free is the
      // worse outcome, but that refusal reaches the BUYER, not the operator.
      //
      // This matters per provider, not per application: with Stripe global and
      // Razorpay for IN, a plan with a trial sells fine in the US and is
      // unbuyable in India, and the router decides which. That is exactly the
      // "fine through one provider and dead through another" case this module
      // exists to surface, so it belongs here rather than as a create-time
      // refusal that would also block an operator who is mid-way through
      // setting providers up.
      // Only for modules buyers can be routed to; an inbound-only module has
      // already said, above, that it hosts no checkout at all.
      if (
        module?.capabilities.checkout !== false &&
        (plan.trialDays ?? 0) > 0 &&
        module?.capabilities.trials !== true
      ) {
        blockers.push({
          provider,
          code: 'PLAN_TRIAL_UNSUPPORTED',
          message:
            `${module?.display.label ?? provider} cannot start a subscription in a free trial, ` +
            `and this plan offers ${plan.trialDays}. Buyers routed to it are refused at checkout.`,
          fix:
            'Remove the trial from this plan, or make sure buyers who would reach this ' +
            'provider are routed to one that supports trials.',
        });
      }
    }
    out.set(plan.id, { ready: blockers.length === 0, blockers });
  }
  return out;
}

async function additionalCurrencies(plans: readonly ReadinessPlan[]): Promise<Map<string, Array<{ currency: string }>>> {
  const defaults = plans.flatMap((plan) => (plan.defaultPriceId === null ? [] : [plan.defaultPriceId]));
  const rows = await prisma.planPrice.findMany({
    where: { planId: { in: plans.map((plan) => plan.id) }, archivedAt: null, id: { notIn: defaults } },
    select: { planId: true, currency: true },
    orderBy: { currency: 'asc' },
  });
  const byPlan = new Map<string, Array<{ currency: string }>>();
  for (const row of rows) byPlan.set(row.planId, [...(byPlan.get(row.planId) ?? []), { currency: row.currency }]);
  return byPlan;
}

/** The single-plan case, for callers that already hold exactly one. */
export async function planCheckoutReadinessFor(
  applicationId: string,
  plan: ReadinessPlan,
): Promise<PlanReadiness> {
  const map = await planCheckoutReadiness(applicationId, [plan]);
  return map.get(plan.id) ?? { ready: true, blockers: [] };
}
