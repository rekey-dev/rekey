/**
 * A plan written straight to the database for a test, with its default price
 * row when it has a flat price. The same write the API makes.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import {
  createPlanWithDefaultPrice,
  updatePlanAndDefaultPrice,
  type DefaultPriceInput,
  type PlanCreateData,
  type PlanUpdateData,
  type PlanWithDefaultPrice,
} from '../src/modules/plans/default-price.js';

/**
 * @example
 * const pro = await seedPlan({ applicationId, slug: 'pro', name: 'Pro' }, { currency: 'USD', amount: 2000 });
 * const free = await seedPlan({ applicationId, slug: 'free', name: 'Free' }, null);
 */
export function seedPlan(data: PlanCreateData, price: DefaultPriceInput | null): Promise<PlanWithDefaultPrice> {
  return createPlanWithDefaultPrice(data, price);
}

/**
 * Change one plan's own columns the way the API does, so the registration on
 * its default price row follows.
 *
 * @example
 * await revisePlan({ id: planId }, { metadata: { stripe: { priceId: 'price_1' } } });
 */
export async function revisePlan(where: Prisma.PlanWhereUniqueInput, data: PlanUpdateData): Promise<PlanWithDefaultPrice> {
  const { id } = await prisma.plan.findUniqueOrThrow({ where, select: { id: true } });
  return updatePlanAndDefaultPrice(id, data);
}

/**
 * The same for every plan a filter matches.
 *
 * @example
 * await revisePlans({ applicationId }, { active: false });
 */
export async function revisePlans(where: Prisma.PlanWhereInput, data: PlanUpdateData): Promise<void> {
  const plans = await prisma.plan.findMany({ where, select: { id: true } });
  for (const { id } of plans) await updatePlanAndDefaultPrice(id, data);
}
