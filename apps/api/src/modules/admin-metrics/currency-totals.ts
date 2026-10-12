/**
 * Money in the super-admin metrics is reported per currency and never added
 * across currencies. These helpers decide the order of a per-currency list.
 */

import type { Prisma } from '@prisma/client';

/**
 * Order per-currency entries so the headline is first.
 *
 * Amounts in different currencies cannot be ranked by size (a rupee total is
 * a larger number than the same money in dollars), so the order is by how
 * many rows contributed, then by currency code. When one of `preferred` (the
 * currency an Application reports in) has an entry, the
 * best-ranked such entry moves to the front.
 *
 * @example
 *   const [headline, ...others] = rankCurrencies(entries, (e) => e.payments, ['INR']);
 */
export function rankCurrencies<T extends { currency: string }>(
  entries: readonly T[],
  rowsOf: (entry: T) => number,
  preferred: readonly string[] = [],
): T[] {
  const ranked = [...entries].sort(
    (a, b) => rowsOf(b) - rowsOf(a) || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0),
  );
  const at = ranked.findIndex((e) => preferred.includes(e.currency));
  if (at <= 0) return ranked;
  const [own] = ranked.splice(at, 1);
  return own === undefined ? ranked : [own, ...ranked];
}

/**
 * The currency an Application reports in, upper-cased, or undefined when its
 * `billingConfig` names none.
 *
 * @example
 *   configuredCurrency({ reportingCurrency: 'inr' }); // 'INR'
 */
export function configuredCurrency(billingConfig: Prisma.JsonValue): string | undefined {
  if (typeof billingConfig !== 'object' || billingConfig === null || Array.isArray(billingConfig)) return undefined;
  const currency = billingConfig.reportingCurrency;
  return typeof currency === 'string' && currency !== '' ? currency.toUpperCase() : undefined;
}
