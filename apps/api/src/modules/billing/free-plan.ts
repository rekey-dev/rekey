import type { Plan } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { WITH_DEFAULT_PRICE, withDefaultPrice } from '../plans/default-price.js';

/**
 * Whether a plan charges nothing at all: no flat price and no metered one.
 *
 * @example
 * costsNothing({ isFree: true }); // true
 */
export function costsNothing(plan: Pick<Plan, 'isFree'>): boolean {
  return plan.isFree;
}

/**
 * The refusal for a priced plan used as the free tier, raised both when an
 * operator nominates one and when a buyer self-activates one.
 *
 * @example
 * if (!costsNothing(plan)) throw freePlanNotFree(plan.slug, 'nominate');
 */
export function freePlanNotFree(slug: string, attempt: 'nominate' | 'activate'): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'BILLING_FREE_PLAN_NOT_FREE',
    message:
      attempt === 'nominate'
        ? `Plan "${slug}" charges money, so it cannot be the free tier every signed-in user gets.`
        : `The Application's default plan "${slug}" is not free, so it cannot be self-activated.`,
    fix:
      attempt === 'nominate'
        ? 'Nominate a plan whose `isFree` is true (one with no `price` that is not a USAGE plan), or pass null to have no free tier. Buyers of a priced plan go through POST /api/v1/billing/checkout.'
        : 'A self-activated plan must be free: `isFree` true, which means no `price` and not a USAGE plan. Send buyers of a priced plan through POST /api/v1/billing/checkout instead.',
  });
}

/**
 * Refuse a `defaultPlanSlug` that is not an active, free plan of this
 * Application. Every write of the setting goes through this.
 *
 * @example
 * await assertNominatableFreePlan(application.id, 'free');
 */
export async function assertNominatableFreePlan(applicationId: string, slug: string): Promise<void> {
  const row = await prisma.plan.findFirst({ where: { applicationId, slug, active: true }, include: WITH_DEFAULT_PRICE });
  const plan = row === null ? null : await withDefaultPrice(row);
  if (!plan) {
    throw new RekeyError({
      statusCode: 400,
      code: 'DEFAULT_PLAN_NOT_FOUND',
      message: `No active plan "${slug}" in this Application.`,
      fix: 'Pass the slug of an existing active plan to use as the free tier, or null to clear it.',
    });
  }
  if (!costsNothing(plan)) throw freePlanNotFree(slug, 'nominate');
}
