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

import type { Plan } from '@prisma/client';
import { billingCredentialsService } from '../billing/credentials.service.js';
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
 */
export async function planCheckoutReadiness(
  applicationId: string,
  plans: Plan[],
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
      fix: 'Connect Stripe, PayPal or Razorpay on the Billing tab. Plans created before that will need registering afterwards.',
    };
    for (const plan of plans) out.set(plan.id, { ready: false, blockers: [blocker] });
    return out;
  }

  for (const plan of plans) {
    const blockers: PlanBlocker[] = [];
    for (const { provider } of enabled) {
      const blocker = getModule(provider)?.planCheckoutBlocker?.(plan);
      if (blocker) blockers.push({ provider, ...blocker });
    }
    out.set(plan.id, { ready: blockers.length === 0, blockers });
  }
  return out;
}

/** The single-plan case, for callers that already hold exactly one. */
export async function planCheckoutReadinessFor(
  applicationId: string,
  plan: Plan,
): Promise<PlanReadiness> {
  const map = await planCheckoutReadiness(applicationId, [plan]);
  return map.get(plan.id) ?? { ready: true, blockers: [] };
}
