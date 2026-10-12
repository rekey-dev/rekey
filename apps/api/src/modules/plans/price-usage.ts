/**
 * Who is on a price right now (the subscriptions that have not ended and the
 * checkouts still open) and whether anything on record names it. A price with
 * either of the first two cannot be removed, and the plan list reports both
 * so an operator sees why before trying. A price any of the three is true of
 * keeps its amount.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export interface PriceUsage {
  liveSubscriptions: number;
  openCheckouts: number;
  /** An ended subscription, a payment or a credit grant names the price. */
  onRecord: boolean;
}

export const NO_PRICE_USAGE: PriceUsage = { liveSubscriptions: 0, openCheckouts: 0, onRecord: false };

const ENDED_SUBSCRIPTION_STATUSES: readonly string[] = ['CANCELED', 'EXPIRED'];

/**
 * A checkout a buyer can still pay.
 *
 * @example
 * await prisma.checkoutSession.count({ where: { planPriceId, ...openCheckout(new Date()) } });
 */
export function openCheckout(now: Date): Prisma.CheckoutSessionWhereInput {
  return { OR: [{ status: 'CONFIRMING' }, { status: 'OPEN', expiresAt: { gt: now } }] };
}

/**
 * The usage of each price named, keyed by price id. Four grouped queries
 * whatever the number of prices, and none for an empty list. A price nobody
 * is on is absent from the map: read it with `?? NO_PRICE_USAGE`.
 *
 * @example
 * const usage = await priceUsageFor(prices.map((price) => price.id));
 * usage.get(price.id)?.liveSubscriptions ?? 0;
 */
export async function priceUsageFor(priceIds: readonly string[]): Promise<Map<string, PriceUsage>> {
  const usage = new Map<string, PriceUsage>();
  if (priceIds.length === 0) return usage;
  const ids = [...new Set(priceIds)];
  const [subscriptions, checkouts, payments, creditGrants] = await Promise.all([
    prisma.subscription.groupBy({
      by: ['planPriceId', 'status'],
      where: { planPriceId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.checkoutSession.groupBy({
      by: ['planPriceId'],
      where: { planPriceId: { in: ids }, ...openCheckout(new Date()) },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({ by: ['planPriceId'], where: { planPriceId: { in: ids } } }),
    prisma.creditLedger.groupBy({ by: ['planPriceId'], where: { planPriceId: { in: ids } } }),
  ]);
  const entry = (priceId: string): PriceUsage => {
    const found = usage.get(priceId) ?? { ...NO_PRICE_USAGE };
    usage.set(priceId, found);
    return found;
  };
  for (const row of subscriptions) {
    if (row.planPriceId === null) continue;
    if (ENDED_SUBSCRIPTION_STATUSES.includes(row.status)) entry(row.planPriceId).onRecord = true;
    else entry(row.planPriceId).liveSubscriptions += row._count._all;
  }
  for (const row of checkouts) if (row.planPriceId !== null) entry(row.planPriceId).openCheckouts = row._count._all;
  for (const row of [...payments, ...creditGrants]) if (row.planPriceId !== null) entry(row.planPriceId).onRecord = true;
  return usage;
}
