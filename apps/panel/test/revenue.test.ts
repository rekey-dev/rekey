/**
 * The Billing overview's figures: one row per currency, the reporting
 * currency first, nothing added across currencies, and unverified money kept
 * out of revenue.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BillingStatsDtoSchema } from '@rekey.dev/shared-types';
import type { BillingStatsRow } from '@/lib/api';
import { currencyFigures, monthlySeries, monthLabel, unverifiedMoney } from '@/lib/revenue';

const months = (amounts: number[]) => amounts.map((amountCents, index) => ({ month: `2026-${String(index + 1).padStart(2, '0')}`, amountCents }));

const STATS: BillingStatsRow = BillingStatsDtoSchema.parse({
  activeSubscriptions: 12,
  pastDueSubscriptions: 1,
  canceledLast30d: 2,
  newSubscriptionsLast30d: 5,
  unpricedLiveSubscriptions: 0,
  reportingCurrency: 'EUR',
  mrr: [
    { currency: 'EUR', mrrCents: 0, activeSubscriptions: 0 },
    { currency: 'USD', mrrCents: 19000, activeSubscriptions: 10 },
    { currency: 'INR', mrrCents: 299800, activeSubscriptions: 2 },
  ],
  revenueLast30d: [
    { currency: 'EUR', grossCents: 0, refundedCents: 0, netCents: 0, payments: 0 },
    { currency: 'USD', grossCents: 20000, refundedCents: 1900, netCents: 18100, payments: 11 },
    { currency: 'JPY', grossCents: 1500, refundedCents: 0, netCents: 1500, payments: 1 },
  ],
  unverified: [
    { currency: 'EUR', amountCents: 0, payments: 0 },
    { currency: 'USD', amountCents: 190000, payments: 1 },
  ],
  paymentsLast30d: { succeeded: 12, failed: 1 },
  monthlyRevenue: [
    { currency: 'EUR', months: months([0, 0, 0]) },
    { currency: 'USD', months: months([1900, 3800, 18100]) },
    { currency: 'GBP', months: months([0, 0, 0]) },
  ],
});

describe('currencyFigures', () => {
  const rows = currencyFigures(STATS);

  it('leads with the reporting currency even at zero, then the rest by code', () => {
    expect(rows.map((row) => row.currency)).toEqual(['EUR', 'INR', 'JPY', 'USD']);
    expect(rows[0]).toMatchObject({ mrr: 0, net: 0 });
  });

  it('joins MRR and revenue per currency and never across them', () => {
    expect(rows.find((row) => row.currency === 'USD')).toEqual({
      currency: 'USD',
      mrr: 19000,
      activeSubscriptions: 10,
      gross: 20000,
      refunded: 1900,
      net: 18100,
      payments: 11,
    });
    expect(rows.find((row) => row.currency === 'INR')).toMatchObject({ mrr: 299800, gross: 0 });
    expect(rows.find((row) => row.currency === 'JPY')).toMatchObject({ mrr: 0, net: 1500 });
  });
});

describe('monthlySeries', () => {
  it('draws one chart per currency that took money, and the reporting currency always', () => {
    const series = monthlySeries(STATS);
    expect(series.map((entry) => entry.currency)).toEqual(['EUR', 'USD']);
    expect(series[1]?.total).toBe(23800);
  });

  it('still draws the reporting currency when the API sent no series for it', () => {
    expect(monthlySeries({ ...STATS, monthlyRevenue: [] }).map((entry) => entry.currency)).toEqual(['EUR']);
  });

  it('labels a month in UTC', () => {
    expect(monthLabel('2026-06')).toBe('Jun');
  });
});

describe('unverifiedMoney', () => {
  it('lists what is held per currency and drops empty rows', () => {
    expect(unverifiedMoney(STATS)).toEqual([{ currency: 'USD', amount: 190000, payments: 1 }]);
  });

  it('is never part of a currency row', () => {
    const usd = currencyFigures(STATS).find((row) => row.currency === 'USD');
    expect(usd?.gross).toBe(20000);
    expect(usd?.net).toBe(18100);
  });
});

describe('the overview page', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../src/app/(authed)/applications/[id]/revenue/page.tsx', import.meta.url)),
    'utf8',
  );

  it('reads none of the removed scalar fields', () => {
    for (const removed of ['mrrCurrency', 'mixedCurrencies', 'revenueCurrency', 'stats.mrrCents', 'stats.revenueLast30dCents']) {
      expect(page).not.toContain(removed);
    }
  });

  it('never sums a list of currencies', () => {
    expect(page).not.toMatch(/\.reduce\([^)]*(mrr|net|gross|amount)/);
  });

  it('links unverified money to the unapplied payments page', () => {
    expect(page).toContain('/unapplied-payments');
    expect(page).toContain('unverifiedMoney(stats)');
  });
});
