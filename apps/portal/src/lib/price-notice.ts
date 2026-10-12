/**
 * The sentences that tell a buyer, before they pay, that the price in their
 * own currency is not the one they will be charged.
 */

import type { PriceFallbackDto, ResolvedPriceDto } from '@rekey.dev/shared-types';

/**
 * A checkout that charges the plan's default price because no payment
 * provider can charge the price selected for the buyer. `chargedText` is the
 * charged price as the page writes its other amounts, when that is not the
 * API's own `formatted`.
 *
 * @example
 * priceFallbackSentence({ requested: { currency: 'INR', … }, charged: { formatted: '$19.00', currency: 'USD', … } });
 * // 'Prices in INR are not available yet. You will pay $19.00 (USD).'
 */
export function priceFallbackSentence(
  fallback: Pick<PriceFallbackDto, 'requested' | 'charged'>,
  chargedText: string = fallback.charged.formatted,
): string {
  const requested = fallback.requested.currency.toUpperCase();
  const charged = fallback.charged.currency.toUpperCase();
  return `Prices in ${requested} are not available yet. You will pay ${chargedText} (${charged}).`;
}

/**
 * The same notice from the catalogue, before any checkout exists. Null when
 * the price shown is the one selected for the buyer.
 *
 * @example
 * catalogueFallbackSentence({ reason: 'fallback', requestedCurrency: 'INR', formatted: '$19.00', currency: 'USD' });
 * // 'A price in INR is not available yet. You will pay $19.00 (USD).'
 */
export function catalogueFallbackSentence(
  price: Pick<ResolvedPriceDto, 'reason' | 'requestedCurrency' | 'formatted' | 'currency'> | null,
): string | null {
  if (price === null || price.reason !== 'fallback' || price.requestedCurrency === null) return null;
  return `A price in ${price.requestedCurrency.toUpperCase()} is not available yet. You will pay ${price.formatted} (${price.currency.toUpperCase()}).`;
}
