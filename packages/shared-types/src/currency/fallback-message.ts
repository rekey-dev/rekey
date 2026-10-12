/**
 * The sentence a buyer is shown when the price selected for them cannot be
 * charged and the plan's default price is charged instead.
 */

/** The two sides of a price fallback this module reads: `PriceFallbackDto` fits. */
export interface PriceFallbackSides {
  requested: { currency: string };
  charged: { formatted: string };
}

/**
 * One plain sentence for the buyer, to show before they pay.
 *
 * @example
 * ```ts
 * priceFallbackMessage({ requested: { currency: 'INR' }, charged: { formatted: '$19.00' } });
 * // 'Prices in INR are not available yet. You will pay $19.00.'
 * ```
 */
export function priceFallbackMessage(fallback: PriceFallbackSides): string {
  return `Prices in ${fallback.requested.currency.toUpperCase()} are not available yet. You will pay ${fallback.charged.formatted}.`;
}
