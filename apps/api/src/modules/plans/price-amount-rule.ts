/**
 * When a price's amount may still change. The one statement of the rule: the
 * routes that change an amount refuse by it, and the plan list reports it as
 * `amountEditable`, so the two cannot disagree.
 *
 * A provider's price object is immutable once created, so an amount is fixed
 * from the moment a provider holds the price. A price a subscription, a
 * checkout, a payment or a credit grant names keeps its amount too, so those
 * records go on saying what was charged.
 */

import type { Plan, PlanPrice, PlanRegistrationStatus } from '@prisma/client';
import { hasAnyRegistration } from '../billing/priced-plan.js';
import { PROVIDER_REGISTRATION_KEYS } from './default-price.js';
import type { PriceUsage } from './price-usage.js';

/**
 * The statuses of an additional price nobody holds and nobody is registering.
 * A checkout registering the price right now has already read its amount.
 */
export const AMOUNT_EDITABLE_STATUSES = ['NOT_REQUIRED', 'FAILED'] as const satisfies readonly PlanRegistrationStatus[];

/**
 * True once any provider has minted a price or plan object for this plan.
 * A plan that failed registration has none, which is why it may be re-priced.
 *
 * @example
 * hasProviderRegistration({ metadata: { stripe: { priceId: 'price_1' } } }); // true
 */
export function hasProviderRegistration(plan: Pick<Plan, 'metadata'>): boolean {
  const meta = (plan.metadata ?? {}) as Record<string, unknown>;
  return PROVIDER_REGISTRATION_KEYS.some((key) => {
    const entry = meta[key];
    return typeof entry === 'object' && entry !== null && Object.keys(entry).length > 0;
  });
}

/**
 * Whether a record names the price: a live subscription, an open checkout, or
 * anything on record at it.
 *
 * @example
 * priceIsReferenced({ liveSubscriptions: 0, openCheckouts: 0, onRecord: true }); // true
 */
export function priceIsReferenced(usage: PriceUsage): boolean {
  return usage.liveSubscriptions > 0 || usage.openCheckouts > 0 || usage.onRecord;
}

/**
 * What fixes the amount of a price in an additional currency, or null when
 * it may change.
 *
 * @example
 * additionalPriceAmountLock({ metadata: {}, registrationStatus: 'NOT_REQUIRED' }, NO_PRICE_USAGE); // null
 */
export function additionalPriceAmountLock(
  price: Pick<PlanPrice, 'metadata' | 'registrationStatus'>,
  usage: PriceUsage,
): 'provider' | 'referenced' | null {
  const unheld = !hasAnyRegistration(price.metadata) && AMOUNT_EDITABLE_STATUSES.some((status) => status === price.registrationStatus);
  if (!unheld) return 'provider';
  return priceIsReferenced(usage) ? 'referenced' : null;
}

/**
 * Whether a request to change a price's amount is accepted. For an
 * additional price that is `additionalPriceAmountLock`. A plan's default
 * price is changed through the plan, which accepts a new amount until a
 * provider holds the plan and never rewrites a row a record names: it
 * archives that row and adds the new amount as a new one.
 *
 * @example
 * priceAmountEditable(price, plan, usage); // false once a provider holds it
 */
export function priceAmountEditable(
  price: Pick<PlanPrice, 'id' | 'metadata' | 'registrationStatus'>,
  plan: Pick<Plan, 'defaultPriceId' | 'metadata'>,
  usage: PriceUsage,
): boolean {
  return price.id === plan.defaultPriceId ? !hasProviderRegistration(plan) : additionalPriceAmountLock(price, usage) === null;
}
