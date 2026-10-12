/**
 * The price of a subscription no checkout priced.
 *
 * A checkout fixes a subscription's price when it completes. A grant, an
 * external activation and an imported row have no checkout, so they take the
 * plan's price in the currency their creator names, and the plan's default
 * price when it names none.
 */

import type { Prisma, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { snapshotSubscriptionPrice, type SnapshotSubscriptionPriceInput } from './subscription-snapshot.js';

export interface SubscriptionPriceColumns {
  currency: string;
  unitAmount: number;
  /** The `PlanPrice` row it came from. */
  planPriceId: string;
}

interface PricedPlanRow {
  id: string;
  applicationId: string;
  slug: string;
  defaultPrice: { id: string; currency: string; amount: number } | null;
}

/**
 * The plan's live price in `currency`, default or additional, and every
 * currency the plan is priced in, the default first.
 *
 * @example
 * const { price, sold } = await planPriceIn(plan, 'inr');
 * price; // { currency: 'INR', unitAmount: 149900, planPriceId: 'pp_1' }, or null
 * sold;  // ['USD', 'INR']
 */
export async function planPriceIn(
  plan: PricedPlanRow,
  currency: string,
  db: Prisma.TransactionClient = prisma,
): Promise<{ price: SubscriptionPriceColumns | null; sold: string[] }> {
  const wanted = currency.toUpperCase();
  const defaultId = plan.defaultPrice?.id ?? null;
  const live = await db.planPrice.findMany({
    where: { planId: plan.id, archivedAt: null },
    select: { id: true, currency: true, amount: true },
    orderBy: { currency: 'asc' },
  });
  const ordered = [...live].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
  const match = ordered.find((row) => row.currency.toUpperCase() === wanted);
  return {
    price: match ? { currency: match.currency, unitAmount: match.amount, planPriceId: match.id } : null,
    sold: ordered.map((row) => row.currency.toUpperCase()),
  };
}

/**
 * The plan's default price as a subscription takes it, or null for a plan
 * with no flat price.
 *
 * @example
 * const price = defaultPriceColumns(plan); // { currency: 'USD', unitAmount: 2000, planPriceId: 'pp_default' }
 */
export function defaultPriceColumns(plan: Pick<PricedPlanRow, 'defaultPrice'>): SubscriptionPriceColumns | null {
  const row = plan.defaultPrice;
  return row === null ? null : { currency: row.currency, unitAmount: row.amount, planPriceId: row.id };
}

/**
 * The refusal for an operator grant in a currency the plan has no price in.
 *
 * @example
 * throw grantCurrencyUnavailable(plan, 'INR', ['USD', 'EUR']);
 */
export function grantCurrencyUnavailable(plan: PricedPlanRow, currency: string, sold: readonly string[]): RekeyError {
  const wanted = currency.toUpperCase();
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_PLAN_CURRENCY_UNAVAILABLE',
    message: `Plan "${plan.slug}" has no price in ${wanted}, so a subscription to it cannot be granted in ${wanted}.`,
    fix: `Pass one of the currencies this plan is priced in (${sold.join(', ')}), or omit \`currency\` and the subscription takes the plan's default price. To grant in ${wanted}, first add that price in Panel → Application → Plans → Edit, or with PUT /api/v1/tenant/applications/${plan.applicationId}/plans/${plan.slug}/prices/${wanted}.`,
  });
}

/**
 * Give a subscription a price only if it has none. Returns whether it did.
 *
 * The condition is in the write itself: a checkout completing at the same
 * moment has the buyer's real price, and must not be overwritten by this one.
 *
 * @example
 * await priceIfUnpriced(subscription.id, { currency: 'INR', unitAmount: 149900, planPriceId: 'pp_1' });
 */
export async function priceIfUnpriced(
  subscriptionId: string,
  price: SubscriptionPriceColumns,
  db: Prisma.TransactionClient = prisma,
  logged?: SnapshotSubscriptionPriceInput['logged'],
): Promise<boolean> {
  const { written } = await snapshotSubscriptionPrice(db, {
    subscriptionId,
    planPriceId: price.planPriceId,
    unitAmountOverride: price.unitAmount,
    onlyIfUnpriced: true,
    logged,
  });
  return written;
}

/**
 * Give a subscription this price whatever it had before. For a row nobody is
 * paying against: a lapsed one a grant brings back in a named currency.
 *
 * @example
 * await replacePrice(lapsed.id, { currency: 'INR', unitAmount: 149900, planPriceId: 'pp_1' }, tx);
 */
export async function replacePrice(
  subscriptionId: string,
  price: SubscriptionPriceColumns,
  db: Prisma.TransactionClient = prisma,
  logged?: SnapshotSubscriptionPriceInput['logged'],
): Promise<void> {
  await snapshotSubscriptionPrice(db, {
    subscriptionId,
    planPriceId: price.planPriceId,
    unitAmountOverride: price.unitAmount,
    logged,
  });
}

/**
 * Whether a checkout is what prices this subscription: it was opened by one,
 * or one has been opened against it since.
 *
 * Such a row is left for its checkout to price when it completes. Pricing it
 * from anything else would fix a currency the buyer never chose.
 *
 * @example
 * if (!(await pricedByCheckout(subscription, tx))) await priceIfUnpriced(subscription.id, price, tx);
 */
export async function pricedByCheckout(
  subscription: Pick<Subscription, 'id' | 'metadata'>,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const metadata = subscription.metadata;
  const openedByCheckout =
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    typeof metadata.checkoutSessionId === 'string';
  if (openedByCheckout) return true;
  const session = await db.checkoutSession.findFirst({
    where: { subscriptionId: subscription.id },
    select: { id: true },
  });
  return session !== null;
}

/**
 * The refusal for an operator grant that names a currency other than the one a
 * live subscription is already on.
 *
 * @example
 * throw grantCurrencyKept(plan, 'INR', 'USD');
 */
export function grantCurrencyKept(plan: Pick<PricedPlanRow, 'slug'>, wanted: string, kept: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'BILLING_SUBSCRIPTION_CURRENCY_KEPT',
    message: `This subscriber already has a live subscription to "${plan.slug}" in ${kept.toUpperCase()}. A grant does not change the currency of a live subscription, so the subscriber keeps their currency.`,
    fix: `Omit \`currency\` (or pass ${kept.toUpperCase()}) to confirm the subscription as it stands. To move the subscriber to ${wanted.toUpperCase()}, cancel the subscription and grant it again with \`currency: "${wanted.toUpperCase()}"\`.`,
  });
}
