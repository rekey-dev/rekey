/**
 * Reading and labelling a plan's prices in other currencies.
 *
 * Pure, so the plan page, its server actions and the tests share one set of
 * rules for what an operator may type and what the panel says back.
 */

import { formatMoney } from './format';
import { readTypedPrice } from './money-input';

/** What a plan carries per additional price. Mirrors `PlanPrice` in `api.ts`. */
export interface PriceLike {
  currency: string;
  amount: number;
  countries: readonly string[];
}

/**
 * An ISO 4217 code from a form field, upper-cased, or null when it is not
 * three letters.
 *
 * @example
 * parsePriceCurrency(' inr '); // 'INR'
 * parsePriceCurrency('rupee'); // null
 */
export function parsePriceCurrency(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * A price amount from a form field, typed the way the currency is written,
 * as the minor units the API stores. Null when it cannot be saved.
 *
 * @example
 * parsePriceAmount('1499', 'INR');  // 149900
 * parsePriceAmount('5000', 'HUF');  // 500000
 * parsePriceAmount('19.99', 'JPY'); // null
 */
export function parsePriceAmount(raw: string, currency: string): number | null {
  const typed = readTypedPrice(raw, currency);
  return typed.ok ? typed.minor : null;
}

/**
 * The countries typed into a price's countries field, or null when any entry
 * is not a two-letter code.
 *
 * A bad entry refuses the whole field. Dropping it would leave the list
 * shorter than the operator meant, and an empty list widens the price to every
 * country where the currency is local.
 *
 * @example
 * parsePriceCountries('in, np'); // ['IN', 'NP']
 * parsePriceCountries('');       // []
 * parsePriceCountries('IN, IND'); // null
 */
export function parsePriceCountries(raw: string): string[] | null {
  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry !== '');
  if (entries.some((entry) => !/^[A-Z]{2}$/.test(entry))) return null;
  return [...new Set(entries)];
}

/**
 * Where a price applies, in words.
 *
 * @example
 * priceCountriesLabel({ currency: 'INR', amount: 149900, countries: [] });
 * // 'where INR is the local currency'
 * priceCountriesLabel({ currency: 'EUR', amount: 1900, countries: ['DE', 'FR'] });
 * // 'DE, FR'
 */
export function priceCountriesLabel(price: PriceLike): string {
  return price.countries.length === 0
    ? `where ${price.currency} is the local currency`
    : price.countries.join(', ');
}

/**
 * The note beside a plan's price in the plans list, or null when the plan has
 * only its default price.
 *
 * @example
 * additionalCurrenciesLabel([{ currency: 'INR', amount: 149900, countries: [] }]); // '+1 currency'
 * additionalCurrenciesLabel([]); // null
 */
export function additionalCurrenciesLabel(prices: readonly PriceLike[]): string | null {
  const count = prices.length;
  if (count === 0) return null;
  return `+${count} ${count === 1 ? 'currency' : 'currencies'}`;
}

/**
 * What the typed amount would be saved as, or why it cannot be saved. Null
 * while either field is still empty or the currency is not three letters.
 *
 * The price shown is formatted from the integer the save sends, so the two
 * cannot disagree.
 *
 * @example
 * priceAmountPreview('1499', 'INR');  // '₹1,499.00'
 * priceAmountPreview('5000', 'HUF');  // 'HUF 5,000'
 * priceAmountPreview('19.99', 'JPY'); // 'JPY has no decimals, so type a whole number.'
 * priceAmountPreview('1499', 'IN');   // null
 */
export function priceAmountPreview(amount: string, currency: string): string | null {
  const code = parsePriceCurrency(currency);
  if (code === null || amount.trim() === '') return null;
  const typed = readTypedPrice(amount, code);
  return typed.ok ? formatMoney(typed.minor, code) : typed.message;
}

/**
 * Whether the add-price form should empty its fields: a successful add has
 * landed that it has not already cleared for. The token going away (the next
 * save in the dialog was something else) is not an add.
 *
 * @example
 * isNewAdd(undefined, 'a1b2c3d4'); // true
 * isNewAdd('a1b2c3d4', undefined); // false
 */
export function isNewAdd(seenToken: string | undefined, addedToken: string | undefined): boolean {
  return addedToken !== undefined && addedToken !== seenToken;
}

/** What these helpers read of a plan. Mirrors `PlanRow` in `api.ts`. */
export interface PricedPlanLike<P extends PriceLike & { isDefault: boolean } = PriceLike & { isDefault: boolean }> {
  prices: readonly P[];
  isFree: boolean;
  kind: string;
}

/**
 * A plan's default price, or null for a plan with no flat price (a free plan,
 * or a usage plan with no base fee).
 *
 * @example
 * defaultPriceOf({ prices: [{ currency: 'USD', amount: 1900, countries: [], isDefault: true }], isFree: false, kind: 'SUBSCRIPTION' })?.amount; // 1900
 */
export function defaultPriceOf<P extends PriceLike & { isDefault: boolean }>(plan: { prices: readonly P[] }): P | null {
  return plan.prices.find((price) => price.isDefault) ?? null;
}

/** A plan's prices other than its default one. */
export function additionalPricesOf<P extends PriceLike & { isDefault: boolean }>(plan: { prices: readonly P[] }): P[] {
  return plan.prices.filter((price) => !price.isDefault);
}

/**
 * The plan's price as the plans table writes it.
 *
 * @example
 * planPriceText(plan);     // '$19.00'
 * planPriceText(freePlan); // 'Free'
 * planPriceText(usagePlan); // 'No base fee'
 */
export function planPriceText(plan: PricedPlanLike): string {
  const price = defaultPriceOf(plan);
  if (price !== null) return formatMoney(price.amount, price.currency);
  return plan.isFree ? 'Free' : 'No base fee';
}

export type PriceRegistrationStatus = 'NOT_REQUIRED' | 'PENDING' | 'REGISTERED' | 'FAILED';

export interface RegistrationNote {
  label: string;
  tone: 'success' | 'neutral' | 'danger';
  /** What the status means for the price. */
  detail: string;
}

/**
 * How a price stands at the payment provider, in words. Whether its amount
 * can change is said on the amount field: see `amountLockReason`.
 *
 * @example
 * registrationNote('REGISTERED').label; // 'registered'
 */
export function registrationNote(status: PriceRegistrationStatus): RegistrationNote {
  switch (status) {
    case 'REGISTERED':
      return {
        label: 'registered',
        tone: 'success',
        detail: 'A payment provider holds this price.',
      };
    case 'PENDING':
      return {
        label: 'registering',
        tone: 'neutral',
        detail: 'A payment provider is registering this price now.',
      };
    case 'FAILED':
      return {
        label: 'registration failed',
        tone: 'danger',
        detail: 'The provider refused this price, so nobody can be charged it. Correct the amount or the provider, then register again.',
      };
    case 'NOT_REQUIRED':
      return {
        label: 'registers at first checkout',
        tone: 'neutral',
        detail: 'No provider holds this price yet. It is registered at the first recurring checkout that uses it.',
      };
  }
}

/**
 * Why a price's amount cannot be changed, to show on its amount field, or
 * null when it can. `amountEditable` is the API's own answer.
 *
 * @example
 * amountLockReason({ amountEditable: false, registration: { status: 'REGISTERED' } });
 * // 'A payment provider holds this price, and a provider price cannot change. ...'
 */
export function amountLockReason(price: {
  amountEditable: boolean;
  registration: { status: PriceRegistrationStatus };
  liveSubscriptions?: number;
  openCheckouts?: number;
}): string | null {
  if (price.amountEditable) return null;
  if (price.registration.status === 'PENDING') {
    return 'A payment provider is registering this price now, so its amount cannot change until that finishes.';
  }
  if (price.registration.status === 'REGISTERED') {
    return 'A payment provider holds this price, and a provider price cannot change. To charge a different amount, archive the plan and create a replacement under another slug.';
  }
  if ((price.liveSubscriptions ?? 0) > 0 || (price.openCheckouts ?? 0) > 0) {
    return 'A subscriber or an open checkout is on this price, so its amount stays as it is. Once nobody is on it, remove it and add the new amount.';
  }
  return 'A payment provider holds this price or a payment was recorded at it, so its amount stays as it is. To charge a different amount, remove this price and add the new amount.';
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Why a price cannot be removed, to show on its remove control, or null when
 * it can: the API refuses while a live subscription or an open checkout is on
 * it.
 *
 * @example
 * removalLockReason({ liveSubscriptions: 3, openCheckouts: 0 });
 * // '3 live subscriptions are on this price. It can be removed once they have ended.'
 */
export function removalLockReason(price: { liveSubscriptions: number; openCheckouts: number }): string | null {
  const { liveSubscriptions: subscriptions, openCheckouts: checkouts } = price;
  if (subscriptions <= 0 && checkouts <= 0) return null;
  const holders = [
    subscriptions > 0 ? counted(subscriptions, 'live subscription', 'live subscriptions') : null,
    checkouts > 0 ? counted(checkouts, 'open checkout', 'open checkouts') : null,
  ].filter((holder) => holder !== null);
  const verb = subscriptions + checkouts === 1 ? 'is' : 'are';
  const until =
    checkouts <= 0
      ? subscriptions === 1 ? 'it has ended' : 'they have ended'
      : subscriptions <= 0
        ? checkouts === 1 ? 'it has completed or expired' : 'they have completed or expired'
        : 'the subscriptions have ended and the checkouts have completed or expired';
  return `${holders.join(' and ')} ${verb} on this price. It can be removed once ${until}.`;
}

export type PlanLocalPricesRule = 'INHERIT' | 'TRUSTED' | 'OFF';

export interface PlanLocalPricesChoice {
  value: PlanLocalPricesRule;
  label: string;
  /** What choosing it does, for the plan's buyers. */
  consequence: string;
}

/**
 * The three rules a plan can have for its prices in other currencies, each
 * with what choosing it does. `defaultCurrency` is the currency of the plan's
 * default price.
 *
 * @example
 * planLocalPricesChoices('USD').find((choice) => choice.value === 'OFF')?.consequence;
 * // "A buyer's country never selects a price. Every new buyer is charged the default price in USD ..."
 */
export function planLocalPricesChoices(defaultCurrency: string): PlanLocalPricesChoice[] {
  return [
    {
      value: 'INHERIT',
      label: 'Follow the Application setting',
      consequence:
        'This plan does what Billing, Setup, Settings says about local prices. When that setting changes, this plan changes with it.',
    },
    {
      value: 'TRUSTED',
      label: 'Verified country only',
      consequence:
        'A buyer is offered a local price only when your server passes their country or a trusted proxy vouches for it. A country the buyer states themselves is ignored, so changing it does not change their price. This holds even when the Application setting allows any country.',
    },
    {
      value: 'OFF',
      label: 'Off',
      consequence: `A buyer's country never selects a price. Every new buyer is charged the default price in ${defaultCurrency}, unless your server names a currency at checkout. The other prices stay on the plan for that, and subscribers already paying in one of them keep it.`,
    },
  ];
}
