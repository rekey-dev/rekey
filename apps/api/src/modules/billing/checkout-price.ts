/**
 * Which of a plan's prices one buyer is charged at, and why.
 *
 * The one decision: checkout, the coupon preview and the `price` on a plan
 * all get their answer here, so a pricing page cannot show a price checkout
 * would not charge.
 *
 * Pure: the caller reads the plan's prices, the buyer and the providers, and
 * this decides. Nothing here touches the database or a processor, so every
 * branch is unit-tested directly.
 */

import type { PriceReason } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import type { BuyerCountry } from './buyer-country.js';
import { localCurrencyOf } from './price-currency.js';

export interface SelectablePrice {
  id: string;
  currency: string;
  amount: number;
  countries: string[];
}

/** One of the plan's price rows, as selected. */
export interface PriceCandidate {
  planPriceId: string;
  currency: string;
  amount: number;
  isDefault: boolean;
}

/** The price that was selected first, when it gave way to the default. */
export interface PriceFallback {
  requested: PriceCandidate;
  /** Why `requested` was selected: the buyer's country, or the currency a server named. */
  requestedBecause: 'requested' | 'country';
  reason: 'no_provider_for_currency';
}

export interface CheckoutPrice extends PriceCandidate {
  /** Why this price and not another. `fallback`: the one selected cannot be charged. */
  reason: PriceReason;
  /** Set exactly when `reason` is `fallback`. */
  fallback: PriceFallback | null;
}

/**
 * Whether a buyer's country may select a local price: `off` never, `trusted`
 * for a country a server declared or a CDN vouched for, `any` for a country a
 * browser merely stated as well.
 */
export type LocalPricesRule = 'off' | 'trusted' | 'any';

export interface SelectCheckoutPriceInput {
  planSlug: string;
  /** The plan's default price row. */
  defaultPrice: SelectablePrice;
  /** The plan's other live prices. Never one in the default price's currency. */
  prices: readonly SelectablePrice[];
  buyer: BuyerCountry | null;
  /** `currency` from the checkout request, as sent. */
  requestedCurrency: string | undefined;
  callerIsSecretKey: boolean;
  localPrices: LocalPricesRule;
  /** What happens to a currency the server named that no provider can charge. */
  onUnavailableCurrency: 'fallback' | 'refuse';
  /**
   * The currency this buyer's live subscription or unfinished checkout at the
   * Application already uses. Stripe refuses a second currency on a customer
   * with an active subscription.
   */
  boundCurrency: string | null;
  /** The one provider this checkout must use, when that is already decided. Named in refusals. */
  onlyProvider?: string | undefined;
  /**
   * Whether a provider this checkout could use can charge the currency. Never
   * asked about the default price's currency: the default is the last resort,
   * and the provider pick that follows the selection owns that refusal.
   */
  chargeable: (currency: string) => boolean;
}

/**
 * The refusal for a buyer whose provider can no longer charge the currency
 * they pay in. It carries the price they are bound to, so a caller pricing a
 * page for them can show that price and say they cannot check out.
 *
 * @example
 * try { selectCheckoutPrice(input); } catch (err) {
 *   if (err instanceof BoundCurrencyUnchargeableError) err.bound.currency; // 'INR'
 * }
 */
export class BoundCurrencyUnchargeableError extends RekeyError {
  constructor(
    public readonly bound: PriceCandidate,
    args: ConstructorParameters<typeof RekeyError>[0],
  ) {
    super(args);
  }
}

function providersPath(onlyProvider: string | undefined, currency: string): string {
  const whose = onlyProvider === undefined ? "a provider's currencies" : `the currencies of "${onlyProvider}"`;
  return `Add ${currency} to ${whose} in Panel → Application → Billing → Setup → Providers → Edit`;
}

/**
 * Pick the price, in this order: the currency the buyer is already bound to;
 * a currency a secret-key caller asked for; the price that applies in the
 * buyer's country, when that country can be believed; the plan's default.
 *
 * A price no provider can charge gives way to the default, and the result
 * says so in `fallback`. The currency a buyer already pays in never gives
 * way. Whether any provider can charge the default is not decided here.
 *
 * @example
 * selectCheckoutPrice({
 *   planSlug: 'pro',
 *   defaultPrice: { id: 'pp_usd', currency: 'USD', amount: 2000, countries: [] },
 *   prices: [{ id: 'pp_inr', currency: 'INR', amount: 149900, countries: [] }],
 *   buyer: { country: 'IN', source: 'declared' },
 *   requestedCurrency: undefined,
 *   callerIsSecretKey: true,
 *   localPrices: 'trusted',
 *   onUnavailableCurrency: 'fallback',
 *   boundCurrency: null,
 *   chargeable: () => true,
 * }); // { planPriceId: 'pp_inr', currency: 'INR', amount: 149900, isDefault: false, reason: 'country', fallback: null }
 */
export function selectCheckoutPrice(input: SelectCheckoutPriceInput): CheckoutPrice {
  const { planSlug } = input;
  const standard: PriceCandidate = {
    planPriceId: input.defaultPrice.id,
    currency: input.defaultPrice.currency.toUpperCase(),
    amount: input.defaultPrice.amount,
    isDefault: true,
  };
  const additional = [...input.prices]
    .map((price) => ({ ...price, currency: price.currency.toUpperCase() }))
    .filter((price) => price.id !== input.defaultPrice.id && price.currency !== standard.currency)
    .sort((a, b) => a.currency.localeCompare(b.currency));
  const candidate = (price: SelectablePrice): PriceCandidate => ({
    planPriceId: price.id,
    currency: price.currency,
    amount: price.amount,
    isDefault: false,
  });
  const priceIn = (currency: string): PriceCandidate | null => {
    if (currency === standard.currency) return standard;
    const match = additional.find((price) => price.currency === currency);
    return match ? candidate(match) : null;
  };

  const chargeable = (currency: string): boolean => currency === standard.currency || input.chargeable(currency);

  const requested = input.requestedCurrency?.toUpperCase();
  if (requested !== undefined && !input.callerIsSecretKey) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_CURRENCY_NOT_ALLOWED',
      message: 'A checkout opened with a publishable key cannot choose its currency.',
      fix: 'Drop `currency` from the request: the price follows the buyer\'s country. To charge a named currency, open the checkout from your server with the secret key and pass `currency` there.',
    });
  }
  const requestedPrice = requested === undefined ? null : priceIn(requested);
  if (requested !== undefined && requestedPrice === null) {
    const sold = [standard.currency, ...additional.map((price) => price.currency)].join(', ');
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_PLAN_CURRENCY_UNAVAILABLE',
      message: `Plan "${planSlug}" has no price in ${requested}.`,
      fix: `Pass one of the currencies this plan is priced in (${sold}), or omit \`currency\` to let the buyer's country decide. Add a ${requested} price in Panel → Application → Plans → Edit, or with PUT /api/v1/tenant/applications/:id/plans/${planSlug}/prices/${requested}.`,
    });
  }

  const bound = input.boundCurrency === null ? null : priceIn(input.boundCurrency.toUpperCase());
  if (requestedPrice !== null && bound !== null && bound.currency !== requestedPrice.currency) {
    throw new RekeyError({
      statusCode: 409,
      code: 'BILLING_CURRENCY_CONFLICT',
      message: `This buyer already pays in ${bound.currency}, so a checkout in ${requestedPrice.currency} cannot be opened for them.`,
      fix: `Omit \`currency\`, or pass ${bound.currency}. A buyer keeps one currency for as long as they have a subscription here.`,
    });
  }
  if (bound !== null) {
    if (chargeable(bound.currency)) return { ...bound, reason: 'bound', fallback: null };
    // Never the default price instead: that would move a subscriber to
    // another currency, which Stripe refuses on a customer with a live
    // subscription and which changes what they pay without asking them.
    throw new BoundCurrencyUnchargeableError(bound, {
      statusCode: 409,
      code: 'BILLING_CURRENCY_CONFLICT',
      message: `This buyer already pays in ${bound.currency}, and ${input.onlyProvider === undefined ? 'no enabled provider is' : `"${input.onlyProvider}", the provider they pay through, is no longer`} set up to charge ${bound.currency}. A subscriber is never moved to another currency, so no checkout can be opened for them.`,
      fix: `${providersPath(input.onlyProvider, bound.currency)}. Their renewals in ${bound.currency} fail until that is done. To sell to this buyer in another currency instead, cancel their subscription, let it end, and open the checkout again.`,
    });
  }

  if (requestedPrice !== null) {
    if (chargeable(requestedPrice.currency)) return { ...requestedPrice, reason: 'requested', fallback: null };
    if (input.onUnavailableCurrency === 'refuse') {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_NO_PROVIDER_FOR_CURRENCY',
        message: `No provider this checkout can use is set up to charge ${requestedPrice.currency}, the currency requested.`,
        fix: `${providersPath(input.onlyProvider, requestedPrice.currency)}${input.onlyProvider === undefined ? '' : ', or drop `provider` from the request'}. To charge the plan's default price instead, send \`onUnavailableCurrency: "fallback"\` with this request, or make that the Application's default: PATCH /api/v1/tenant/applications/:id/billing-config with {"onUnavailableCurrency": "fallback"} (Panel → Application → Billing → Setup → Defaults → When a currency cannot be charged).`,
      });
    }
    return fallBack(standard, requestedPrice, 'requested');
  }

  const local = localPrice(input, additional);
  if (local !== null) {
    const selected = candidate(local);
    if (chargeable(selected.currency)) return { ...selected, reason: 'country', fallback: null };
    return fallBack(standard, selected, 'country');
  }

  return { ...standard, reason: 'default', fallback: null };
}

function fallBack(
  standard: PriceCandidate,
  requested: PriceCandidate,
  requestedBecause: PriceFallback['requestedBecause'],
): CheckoutPrice {
  return {
    ...standard,
    reason: 'fallback',
    fallback: { requested, requestedBecause, reason: 'no_provider_for_currency' },
  };
}

function localPrice(input: SelectCheckoutPriceInput, additional: readonly SelectablePrice[]): SelectablePrice | null {
  const { buyer } = input;
  if (buyer === null || input.localPrices === 'off') return null;
  // A cheaper local price is worth lying for, so a country a browser merely
  // states selects nothing unless the operator opted into that.
  const believed = buyer.source === 'declared' || buyer.source === 'vouched' || input.localPrices === 'any';
  if (!believed) return null;

  const country = buyer.country.toUpperCase();
  const local = localCurrencyOf(country);
  return (
    additional.find((price) => price.countries.some((c) => c.toUpperCase() === country)) ??
    additional.find((price) => price.countries.length === 0 && price.currency === local) ??
    null
  );
}
