/**
 * Format helpers — kept tiny and dependency-free. Tailwind handles styling;
 * this module just turns server data into display strings.
 */

/**
 * Format an integer amount in the smallest currency unit as a human price
 * string. e.g. (999, 'USD') → '$9.99'. Uses Intl.NumberFormat for locale
 * decimals — the panel runs server-side, so the locale is the server's.
 */
export function formatMoney(amount: number, currency: string): string {
  // Most non-zero-decimal currencies are two-decimal; we hard-code that
  // for the MVP. JPY/KRW/etc. are zero-decimal — future improvement is
  // a lookup table or use the runtime locale's currency formatter.
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

export function formatPercent(basisPointsTimesTen: number): string {
  return `${(basisPointsTimesTen / 100).toFixed(2)}%`;
}
