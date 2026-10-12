/**
 * The Billing overview's figures, one row per currency.
 *
 * Nothing here adds two currencies together and nothing converts: a local
 * price may be set for what buyers in that country can pay, so a converted
 * total would describe money nobody was charged. The reporting currency
 * leads because the operator chose it, not because it is the largest.
 */

import type { BillingStatsRow } from './api';

export interface CurrencyFigures {
  currency: string;
  /** Monthly recurring revenue, minor units. Yearly plans count as a twelfth. */
  mrr: number;
  activeSubscriptions: number;
  /** Last 30 days, minor units. `net` is `gross` less `refunded`. */
  gross: number;
  refunded: number;
  net: number;
  payments: number;
}

type StatsLike = Pick<BillingStatsRow, 'reportingCurrency' | 'mrr' | 'revenueLast30d' | 'monthlyRevenue' | 'unverified'>;

function hasMoney(row: CurrencyFigures): boolean {
  return row.mrr !== 0 || row.gross !== 0 || row.refunded !== 0 || row.activeSubscriptions !== 0 || row.payments !== 0;
}

/**
 * One row per currency with any MRR or revenue, the reporting currency first
 * and always present, the rest by code.
 *
 * @example
 * currencyFigures(stats).map((row) => row.currency); // ['USD', 'EUR', 'INR']
 */
export function currencyFigures(stats: StatsLike): CurrencyFigures[] {
  const reporting = stats.reportingCurrency.toUpperCase();
  const rows = new Map<string, CurrencyFigures>();
  const row = (currency: string): CurrencyFigures => {
    const code = currency.toUpperCase();
    const existing = rows.get(code);
    if (existing) return existing;
    const created = { currency: code, mrr: 0, activeSubscriptions: 0, gross: 0, refunded: 0, net: 0, payments: 0 };
    rows.set(code, created);
    return created;
  };
  row(reporting);
  for (const entry of stats.mrr) {
    const target = row(entry.currency);
    target.mrr = entry.mrrCents;
    target.activeSubscriptions = entry.activeSubscriptions;
  }
  for (const entry of stats.revenueLast30d) {
    const target = row(entry.currency);
    target.gross = entry.grossCents;
    target.refunded = entry.refundedCents;
    target.net = entry.netCents;
    target.payments = entry.payments;
  }
  return [...rows.values()]
    .filter((entry) => entry.currency === reporting || hasMoney(entry))
    .sort((a, b) => Number(b.currency === reporting) - Number(a.currency === reporting) || a.currency.localeCompare(b.currency));
}

export interface MonthlySeries {
  currency: string;
  months: Array<{ month: string; amount: number }>;
  total: number;
}

/**
 * The monthly revenue charts to draw: one per currency that took money in the
 * last twelve months, each on its own scale, the reporting currency first and
 * drawn even when empty.
 *
 * @example
 * monthlySeries(stats).map((series) => series.currency); // ['USD', 'INR']
 */
export function monthlySeries(stats: StatsLike): MonthlySeries[] {
  const reporting = stats.reportingCurrency.toUpperCase();
  const series = stats.monthlyRevenue.map((entry) => ({
    currency: entry.currency.toUpperCase(),
    months: entry.months.map((point) => ({ month: point.month, amount: point.amountCents })),
    total: entry.months.reduce((sum, point) => sum + point.amountCents, 0),
  }));
  if (!series.some((entry) => entry.currency === reporting)) series.push({ currency: reporting, months: [], total: 0 });
  return series
    .filter((entry) => entry.currency === reporting || entry.months.some((point) => point.amount !== 0))
    .sort((a, b) => Number(b.currency === reporting) - Number(a.currency === reporting) || a.currency.localeCompare(b.currency));
}

/**
 * Money held in unverified payments, per currency, in the order the API
 * sends it. Rows with nothing held are dropped.
 */
export function unverifiedMoney(stats: StatsLike): Array<{ currency: string; amount: number; payments: number }> {
  return stats.unverified
    .filter((entry) => entry.amountCents !== 0 || entry.payments !== 0)
    .map((entry) => ({ currency: entry.currency.toUpperCase(), amount: entry.amountCents, payments: entry.payments }));
}

/** "Jun" for "2026-06", in UTC, matching the API's UTC month buckets. */
export function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1)).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
}
