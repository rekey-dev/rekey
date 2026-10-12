/**
 * A subscription price for a fixture that writes one straight to the row.
 *
 * A subscription's price is three columns set together, and one of them names
 * a `PlanPrice`. A test that only cares about the currency and the amount gets
 * a row to name here: the plan's own price in that currency when it has one,
 * and an archived one otherwise, which is what a subscriber on a price the
 * plan no longer sells looks like.
 */

import { prisma } from '../src/lib/prisma.js';

export async function pricedAt(
  planId: string,
  currency: string,
  unitAmount: number,
): Promise<{ currency: string; unitAmount: number; planPriceId: string }> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId }, select: { applicationId: true } });
  const code = currency.toUpperCase();
  const known = await prisma.planPrice.findFirst({
    where: { planId, currency: code },
    orderBy: { archivedAt: { sort: 'asc', nulls: 'first' } },
  });
  const price =
    known ??
    (await prisma.planPrice.create({
      data: { applicationId: plan.applicationId, planId, currency: code, amount: Math.max(unitAmount, 1), archivedAt: new Date() },
    }));
  return { currency, unitAmount, planPriceId: price.id };
}
