/**
 * The plans a grant can name, and the currencies each one can be granted in.
 *
 * Pure, so the grant dialog and its tests share one rule: a plan offers its
 * own price first and then its prices in other currencies, and nothing else.
 */

import type { PlanRow } from './api';
import { formatMoney } from './format';
import { defaultPriceOf, planPriceText } from './plan-prices';

export interface GrantPriceOption {
  /** ISO 4217, upper-case. Sent as the grant's `currency`. */
  currency: string;
  /** The price in that currency, e.g. "₹1,499.00". */
  price: string;
}

export interface GrantPlanOption {
  slug: string;
  label: string;
  /** The plan's own price first, then its other currencies. */
  prices: GrantPriceOption[];
}

type GrantablePlan = Pick<PlanRow, 'slug' | 'name' | 'interval' | 'prices' | 'isFree' | 'kind'>;

/**
 * @example
 * grantPlanOptions([{ slug: 'pro', name: 'Pro', interval: 'MONTH', isFree: false, kind: 'SUBSCRIPTION',
 *   prices: [{ currency: 'USD', amount: 1900, isDefault: true, ... }, { currency: 'INR', amount: 149900, isDefault: false, ... }] }]);
 * // [{ slug: 'pro', label: 'Pro ($19.00 / month)', prices: [
 * //   { currency: 'USD', price: '$19.00' }, { currency: 'INR', price: '₹1,499.00' }] }]
 */
export function grantPlanOptions(plans: readonly GrantablePlan[]): GrantPlanOption[] {
  return plans.map((plan) => ({
    slug: plan.slug,
    label:
      defaultPriceOf(plan) === null
        ? `${plan.name} (${planPriceText(plan)})`
        : `${plan.name} (${planPriceText(plan)} / ${plan.interval.toLowerCase()})`,
    // The API lists the default price first.
    prices: plan.prices.map((price) => ({
      currency: price.currency.toUpperCase(),
      price: formatMoney(price.amount, price.currency),
    })),
  }));
}

/** A subscription this end-user already holds, as far as the grant dialog needs it. */
export interface HeldSubscription {
  planSlug: string;
  status: string;
  /** The subscription's own currency. Null when it has no price of its own. */
  currency: string | null;
}

export type GrantRestriction =
  | { kind: 'none' }
  /** A checkout for this plan is open and unpaid: naming a currency is refused. */
  | { kind: 'unsettled'; reason: string }
  /** A live subscription to this plan exists in a currency: a grant in another one is refused. */
  | { kind: 'held'; currency: string; reason: string };

const ENDED = new Set(['CANCELED', 'EXPIRED']);

/**
 * What the end-user's existing subscription to a plan means for a grant of
 * it, known before the operator submits.
 *
 * The API refuses a named currency with `BILLING_SUBSCRIPTION_PRICE_UNSETTLED`
 * when the plan's subscription was opened by a checkout that has not been
 * paid, and keeps a subscriber's own currency whatever a grant names.
 *
 * @example
 * grantRestriction([{ planSlug: 'pro', status: 'PENDING', currency: 'USD' }], 'pro').kind; // 'unsettled'
 */
export function grantRestriction(held: readonly HeldSubscription[], planSlug: string): GrantRestriction {
  const existing = held.find((subscription) => subscription.planSlug === planSlug && !ENDED.has(subscription.status));
  if (existing === undefined) return { kind: 'none' };
  if (existing.status === 'PENDING') {
    return {
      kind: 'unsettled',
      reason:
        'This end-user has an open, unpaid checkout for this plan. Its price is settled by that checkout when it is paid, so a grant cannot name a currency for it. Grant at the plan default, or wait for the checkout to be paid or to expire.',
    };
  }
  // A live subscription with no price of its own binds no currency: the grant prices it.
  if (existing.currency === null) return { kind: 'none' };
  return {
    kind: 'held',
    currency: existing.currency.toUpperCase(),
    reason: `This end-user already has a live subscription to this plan in ${existing.currency.toUpperCase()}. A subscriber keeps their currency for the life of the subscription, so the other currencies are switched off: a grant in one of them would be refused and change nothing. To bill them in another currency, cancel that subscription first.`,
  };
}

export interface GrantCurrencyChoice {
  /** The select value: a currency, or '' to send none. */
  value: string;
  label: string;
  /** True when the API would refuse a grant that sends it. */
  disabled: boolean;
}

export interface GrantCurrencyControl {
  choices: GrantCurrencyChoice[];
  /** What the select shows and the form sends: never a switched-off choice. */
  value: string;
}

/**
 * The currency select of the grant dialog: every choice, which of them the
 * existing subscription switches off, and the one selected.
 *
 * With a live subscription in a currency, only that currency can be sent.
 * Sending none is offered too when it says the same thing: the plan's default
 * price is in that currency, or the plan no longer sells in it and the grant
 * can only confirm the subscription as it stands.
 *
 * @example
 * grantCurrencyControl(prices, { kind: 'held', currency: 'INR', reason }, 'USD');
 * // { value: 'INR', choices: [{ value: '', disabled: true, ... }, { value: 'USD', disabled: true, ... }, { value: 'INR', disabled: false, ... }] }
 */
export function grantCurrencyControl(
  prices: readonly GrantPriceOption[],
  restriction: GrantRestriction,
  wanted: string,
): GrantCurrencyControl {
  const defaultPrice = prices[0];
  const held = restriction.kind === 'held' ? restriction.currency : null;
  const heldIsSold = held !== null && prices.some((price) => price.currency === held);
  const noneIsOffered = held === null || !heldIsSold || defaultPrice?.currency === held;
  const choices: GrantCurrencyChoice[] = [
    {
      value: '',
      label:
        held !== null && !heldIsSold
          ? `Keep ${held}: the plan no longer sells in it`
          : defaultPrice
            ? `Plan default (${defaultPrice.currency}, ${defaultPrice.price})`
            : 'Plan default',
      disabled: !noneIsOffered,
    },
    ...prices.map((price) => ({
      value: price.currency,
      label: `${price.currency}, ${price.price}`,
      disabled: restriction.kind === 'unsettled' || (held !== null && price.currency !== held),
    })),
  ];
  const open = choices.filter((choice) => !choice.disabled).map((choice) => choice.value);
  return { choices, value: open.includes(wanted) ? wanted : (open.find((value) => value === held) ?? open[0] ?? '') };
}
