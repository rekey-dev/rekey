/**
 * Copy and number formatting for the checkout page.
 *
 * Amounts use `Intl.NumberFormat` in the plan's own currency with the buyer's
 * locale, so `en-IN` gets lakh grouping. The minor-unit divisor is the
 * portal's existing one, which already handles zero-decimal currencies.
 */

import { minorUnitDivisor } from './format';

export type CheckoutLocale = 'en-US' | 'en-IN';

/**
 * The launch locales are `en` and `en-IN`; anything else reads as `en-US`.
 *
 * @example
 * checkoutLocale('en-IN,en;q=0.9'); // 'en-IN'
 */
export function checkoutLocale(acceptLanguage: string | null | undefined): CheckoutLocale {
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en-in') ? 'en-IN' : 'en-US';
}

/**
 * @example
 * formatMoney(9900, 'USD', 'en-US'); // '$99.00'
 */
export function formatMoney(amountMinor: number, currency: string, locale: CheckoutLocale): string {
  const divisor = minorUnitDivisor(currency);
  const digits = divisor === 1 ? 0 : divisor === 1000 ? 3 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amountMinor / divisor);
  } catch {
    return `${(amountMinor / divisor).toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

/** "month" / "year", or null for a one-time purchase. */
export function intervalWord(interval: 'MONTH' | 'YEAR' | null): string | null {
  if (interval === 'MONTH') return 'month';
  if (interval === 'YEAR') return 'year';
  return null;
}

/** WCAG relative luminance of a `#rgb` / `#rrggbb` colour, or null for anything else. */
function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const full = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  const channel = (i: number): number => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * An operator surface colour light enough to keep the page's near-black text
 * at 4.5:1 or better, or null to keep the neutral default.
 *
 * @example
 * readableSurface('#0b0b0b'); // null
 */
export function readableSurface(color: string | null): string | null {
  if (color === null) return null;
  const l = luminance(color);
  if (l === null) return null;
  const text = luminance('#171717')!;
  return (l + 0.05) / (text + 0.05) >= 4.5 ? color : null;
}

/**
 * The operator's accent when it keeps 4.5:1 against white, otherwise the
 * neutral default, so link text stays readable whatever colour was chosen.
 *
 * @example
 * readableAccent('#ffeb3b'); // '#171717'
 */
export function readableAccent(color: string | null): string {
  const fallback = '#171717';
  if (color === null) return fallback;
  const l = luminance(color);
  if (l === null) return fallback;
  return 1.05 / (l + 0.05) >= 4.5 ? color : fallback;
}
