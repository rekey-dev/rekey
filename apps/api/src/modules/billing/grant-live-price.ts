/**
 * What a grant does to the price of a subscription that is already live: the
 * one case where the grant is otherwise a no-op.
 */

import type { Prisma, Subscription } from '@prisma/client';
import { RekeyError } from '../../lib/error.js';
import type { SnapshotSubscriptionPriceInput } from './subscription-snapshot.js';
import {
  defaultPriceColumns,
  grantCurrencyKept,
  pricedByCheckout,
  priceIfUnpriced,
  type SubscriptionPriceColumns,
} from './unpriced-subscription.js';

interface GrantedPlan {
  id: string;
  applicationId: string;
  slug: string;
  defaultPrice: { id: string; currency: string; amount: number } | null;
}

/**
 * The live row as the grant leaves it.
 *
 * A row with a price keeps it: a grant naming that currency, or none, returns
 * it as it is, and one naming another is refused with 409
 * BILLING_SUBSCRIPTION_CURRENCY_KEPT instead of answering 201 for a currency
 * it did not apply.
 *
 * A row with no price is priced here, through `snapshotSubscriptionPrice`, at
 * the price named or the plan's default when none is. The exception is a row a
 * checkout opened: its checkout is what says what the buyer pays, so it is
 * left alone, and a grant that names a currency for it is refused with 409
 * BILLING_SUBSCRIPTION_PRICE_UNSETTLED.
 *
 * @example
 * const row = await withGrantedPrice(tx, existing, plan, { currency: 'INR', unitAmount: 149900, planPriceId: 'pp_1' }, logged);
 */
export async function withGrantedPrice(
  tx: Prisma.TransactionClient,
  existing: Subscription,
  plan: GrantedPlan,
  named: SubscriptionPriceColumns | null,
  logged: SnapshotSubscriptionPriceInput['logged'],
): Promise<Subscription> {
  if (existing.currency !== null) {
    if (named === null || existing.currency.toUpperCase() === named.currency.toUpperCase()) return existing;
    throw grantCurrencyKept(plan, named.currency, existing.currency);
  }
  if (await pricedByCheckout(existing, tx)) {
    if (named === null) return existing;
    throw grantPriceUnsettled(plan, named.currency);
  }
  const taken = named ?? defaultPriceColumns(plan);
  if (taken === null) return existing;
  await priceIfUnpriced(existing.id, taken, tx, logged);
  const current = await tx.subscription.findUniqueOrThrow({ where: { id: existing.id } });
  if (current.currency === null || current.currency.toUpperCase() === taken.currency.toUpperCase()) return current;
  // A checkout completed between the read and the write and priced the row.
  if (named === null) return current;
  throw grantCurrencyKept(plan, named.currency, current.currency);
}

function grantPriceUnsettled(plan: Pick<GrantedPlan, 'slug'>, wanted: string): RekeyError {
  const currency = wanted.toUpperCase();
  return new RekeyError({
    statusCode: 409,
    code: 'BILLING_SUBSCRIPTION_PRICE_UNSETTLED',
    message: `This subscriber has a live subscription to "${plan.slug}" that a checkout opened and that has no price recorded, so a grant cannot put it in ${currency}.`,
    fix: `Omit \`currency\` to confirm the subscription as it stands. To put the subscriber on the ${currency} price, cancel the subscription and grant it again with \`currency: "${currency}"\`.`,
  });
}
