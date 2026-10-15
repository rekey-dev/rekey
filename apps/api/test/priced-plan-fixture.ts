/**
 * A `PricedPlan` for provider tests that hold a plan as a plain object.
 *
 * The real `pricedPlan` takes a plan with its default price row. A fixture
 * names the flat price beside the plan (`amount` and `currency`, 0 for none),
 * and this builds the row from it and hands both to `pricedPlan`.
 */

import type { Plan, PlanPrice } from '@prisma/client';
import { pricedPlan } from '../src/modules/billing/priced-plan.js';
import type { PricedPlan } from '../src/modules/billing/providers/types.js';

type PriceRow = Pick<PlanPrice, 'id' | 'currency' | 'amount' | 'metadata'>;

/** A plan row and the flat price the fixture sells it at. */
export type FixturePlan = Plan & { amount: number; currency: string };

/**
 * @example
 * const standard = pricedPlanFixture(plan, null);  // at the fixture's own amount
 * const local = pricedPlanFixture(plan, inrPrice); // at an additional price
 */
export function pricedPlanFixture(fixture: FixturePlan, price: PriceRow | null = null): PricedPlan {
  const { amount, currency, ...plan } = fixture;
  const defaultPrice =
    amount > 0
      ? ({
          id: plan.defaultPriceId ?? `pp_default_${plan.id}`,
          applicationId: plan.applicationId,
          planId: plan.id,
          currency,
          amount,
          countries: [],
          metadata: plan.metadata,
          registrationStatus: plan.registrationStatus,
          registrationError: plan.registrationError,
          archivedAt: null,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        } satisfies PlanPrice)
      : null;
  return pricedPlan({ ...plan, defaultPriceId: defaultPrice?.id ?? null, defaultPrice }, price, currency);
}
