/**
 * Number formatting for analytics: exact below 10,000, compact above ("48.2k")
 * with the exact value kept for a title attribute; percentages to one decimal;
 * differences between two rates in points, never "percent of a percent".
 */

const FULL = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** @example formatCount(48210) // "48.2K" */
export function formatCount(n: number): string {
  return Math.abs(n) < 10_000 ? FULL.format(n) : COMPACT.format(n);
}

/** The exact value, for a `title` beside a compact one. */
export function formatExact(n: number): string {
  return FULL.format(n);
}

/** A ratio (0.217) as "21.7%". */
export function formatShare(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** A difference between two ratios as "+0.3 pt". */
export function formatPoints(diff: number): string {
  const pts = diff * 100;
  const rounded = Math.abs(pts) < 0.05 ? 0 : pts;
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded).toFixed(1)} pt`;
}
