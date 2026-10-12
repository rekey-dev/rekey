/**
 * A `PricedPlan` for provider tests that hold a plan as a plain object.
 *
 * The real `pricedPlan` takes a plan with its default price row. A fixture
 * has none, so this builds the row the plan's own `amount` and `currency`
 * describe, the way the one writer would, and hands both to `pricedPlan`.
 */

import type { Plan, PlanPrice } from '@prisma/client';
import { pricedPlan } from '../src/modules/billing/priced-plan.js';
import type { PricedPlan } from '../src/modules/billing/providers/types.js';

type PriceRow = Pick<PlanPrice, 'id' | 'currency' | 'amount' | 'metadata'>;

/**
 * @example
 * const standard = pricedPlanFixture(plan, null);  // at the plan's own amount
 * const local = pricedPlanFixture(plan, inrPrice); // at an additional price
 */
export function pricedPlanFixture(plan: Plan, price: PriceRow | null = null): PricedPlan {
  const defaultPrice =
    plan.amount > 0
      ? ({
          id: plan.defaultPriceId ?? `pp_default_${plan.id}`,
          applicationId: plan.applicationId,
          planId: plan.id,
          currency: plan.currency,
          amount: plan.amount,
          countries: [],
          metadata: plan.metadata,
          registrationStatus: plan.registrationStatus,
          registrationError: plan.registrationError,
          archivedAt: null,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        } satisfies PlanPrice)
      : null;
  return pricedPlan({ ...plan, defaultPriceId: defaultPrice?.id ?? null, defaultPrice }, price, plan.currency);
}
