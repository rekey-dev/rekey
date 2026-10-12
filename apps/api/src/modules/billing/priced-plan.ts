/**
 * Builds the `PricedPlan` a checkout hands its provider: the plan at the price
 * selected, with the registration that belongs to that price.
 */

import type { PlanPrice } from '@prisma/client';
import type { PlanWithDefaultPrice } from '../plans/default-price.js';
import type { PricedPlan } from './providers/types.js';

type PriceRow = Pick<PlanPrice, 'id' | 'currency' | 'amount' | 'metadata'>;

/**
 * The plan at one of its prices. `price` null means its default price. A plan
 * with no flat price is charged 0 in `unpricedCurrency`, and keeps the
 * registration on `Plan.metadata`, having no price row to hold one.
 *
 * @example
 * const local = pricedPlan(plan, inrPrice, 'USD'); // local.currency === 'INR'
 * const standard = pricedPlan(plan, null, 'USD');  // standard.planPriceId === plan.defaultPrice.id
 */
export function pricedPlan(plan: PlanWithDefaultPrice, price: PriceRow | null, unpricedCurrency: string): PricedPlan {
  const selected = price ?? plan.defaultPrice;
  if (selected === null) {
    return {
      ...plan,
      amount: 0,
      currency: unpricedCurrency.toUpperCase(),
      planPriceId: null,
      isDefaultPrice: false,
      registration: plan.metadata,
    };
  }
  return {
    ...plan,
    amount: selected.amount,
    currency: selected.currency,
    planPriceId: selected.id,
    isDefaultPrice: selected.id === plan.defaultPriceId,
    registration: selected.metadata,
  };
}

export interface ProviderRegistration {
  priceId?: string;
  planId?: string;
  mode?: string;
}

/**
 * The stored provider registration for this price, or an empty object.
 *
 * @example
 * const { priceId } = providerRegistration(plan, 'stripe');
 */
export function providerRegistration(
  plan: Pick<PricedPlan, 'registration'>,
  provider: string,
): ProviderRegistration {
  const all = plan.registration;
  if (typeof all !== 'object' || all === null || Array.isArray(all)) return {};
  const entry = all[provider];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return {};
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const priceId = text(entry.priceId);
  const planId = text(entry.planId);
  const mode = text(entry.mode);
  return {
    ...(priceId !== undefined && { priceId }),
    ...(planId !== undefined && { planId }),
    ...(mode !== undefined && { mode }),
  };
}

/**
 * Whether any provider has minted a price or plan object for this metadata.
 *
 * @example
 * hasAnyRegistration({ stripe: { priceId: 'price_1' } }); // true
 */
export function hasAnyRegistration(metadata: PlanPrice['metadata']): boolean {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false;
  return Object.keys(metadata).some((provider) => {
    const entry = providerRegistration({ registration: metadata }, provider);
    return entry.priceId !== undefined || entry.planId !== undefined;
  });
}
