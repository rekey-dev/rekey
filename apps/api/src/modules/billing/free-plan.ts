import type { Plan } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

/**
 * Whether a plan charges nothing at all.
 *
 * A plan carries exactly one price: `amount` per interval, plus
 * `pricePerUnitCents` for metered use. Free means both are empty. A zero
 * `amount` with a per-unit price is metered, not free.
 *
 * @example
 * costsNothing({ amount: 0, pricePerUnitCents: null }); // true
 * costsNothing({ amount: 0, pricePerUnitCents: 5 }); // false
 */
export function costsNothing(plan: Pick<Plan, 'amount' | 'pricePerUnitCents'>): boolean {
  return plan.amount === 0 && plan.pricePerUnitCents === null;
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
        ? 'Nominate a plan with `amount` 0 and no `pricePerUnitCents`, or pass null to have no free tier. Buyers of a priced plan go through POST /api/v1/billing/checkout.'
        : 'A self-activated plan must cost nothing on both axes: `amount` 0 and no `pricePerUnitCents`. Send buyers of a priced plan through POST /api/v1/billing/checkout instead.',
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
  const plan = await prisma.plan.findFirst({
    where: { applicationId, slug, active: true },
    select: { amount: true, pricePerUnitCents: true },
  });
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
