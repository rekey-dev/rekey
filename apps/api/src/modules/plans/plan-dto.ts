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
 * Batched: one credential read for the whole page, whatever its size. The
 * public route is hit on every pricing page load, so this must not grow with
 * the number of plans (pinned by a query-count test).
 */

import type { Plan } from '@prisma/client';
import { planCheckoutReadiness, type PlanReadiness } from './plan-readiness.js';

export type PlanAudience = 'public' | 'operator';

export type OperatorPlan = Plan & { checkout: PlanReadiness };
export type PublicPlan = Plan & { checkout: { ready: boolean } };

const READY: PlanReadiness = { ready: true, blockers: [] };

export async function serializePlans(applicationId: string, plans: Plan[], audience: 'operator'): Promise<OperatorPlan[]>;
export async function serializePlans(applicationId: string, plans: Plan[], audience: 'public'): Promise<PublicPlan[]>;
export async function serializePlans(
  applicationId: string,
  plans: Plan[],
  audience: PlanAudience,
): Promise<Array<OperatorPlan | PublicPlan>> {
  const readiness = await planCheckoutReadiness(applicationId, plans);
  return plans.map((plan) => {
    const checkout = readiness.get(plan.id) ?? READY;
    return audience === 'operator'
      ? { ...plan, checkout }
      : { ...plan, checkout: { ready: checkout.ready } };
  });
}
