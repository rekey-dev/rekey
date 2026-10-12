/**
 * Copy and number formatting for the checkout page.
 *
 * Amounts are written by the currency registry in the buyer's locale, so
 * `en-IN` gets lakh grouping.
 */

import { formatMoney as formatRegistryMoney } from '@rekey.dev/shared-types/currency';

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
  return formatRegistryMoney(amountMinor, currency, locale);
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

const MIN_TEXT_CONTRAST = 4.5;
/** The page's secondary text (`--ck-muted-fg`), the lightest text drawn on a surface. */
const MUTED_TEXT = '#525252';
const DEFAULT_ACCENT = '#171717';

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * An operator surface colour light enough to keep the page's text, down to
 * its muted secondary text, at 4.5:1 or better, or null to keep the neutral
 * default.
 *
 * @example
 * readableSurface('#808080'); // null: near-black text passes, muted text does not
 */
export function readableSurface(color: string | null): string | null {
  if (color === null) return null;
  const l = luminance(color);
  if (l === null) return null;
  return l > luminance(MUTED_TEXT)! && contrast(l, luminance(MUTED_TEXT)!) >= MIN_TEXT_CONTRAST ? color : null;
}

/**
 * The operator's accent when it keeps 4.5:1 against white, which is the pay
 * button's text, and against every surface it is drawn on as link text.
 * Otherwise the neutral default.
 *
 * @example
 * readableAccent('#ffeb3b'); // '#171717'
 * readableAccent('#0f766e', ['#d4d4d4']); // '#171717': fine on white, too faint on that surface
 */
export function readableAccent(color: string | null, surfaces: ReadonlyArray<string | null> = []): string {
  if (color === null) return DEFAULT_ACCENT;
  const l = luminance(color);
  if (l === null) return DEFAULT_ACCENT;
  const behind = ['#ffffff', ...surfaces].map((s) => (s === null ? null : luminance(s))).filter((s): s is number => s !== null);
  return behind.every((s) => contrast(l, s) >= MIN_TEXT_CONTRAST) ? color : DEFAULT_ACCENT;
}
