import * as React from 'react';
import { formatMoney } from '@/lib/format';
import { monthLabel, type MonthlySeries } from '@/lib/revenue';

/**
 * One currency's revenue by month, as plain bars with no chart library. Bars are scaled to this
 * currency's own largest month. Two currencies are never drawn on one axis,
 * since their heights would compare amounts that are not comparable.
 */
export function RevenueChart({ series }: { series: MonthlySeries }): React.JSX.Element {
  const max = Math.max(1, ...series.months.map((point) => point.amount));
  return (
    <div>
      {/* The bars' hover titles are not focusable, so the values live in this table for a screen reader. */}
      <table className="sr-only">
        <caption>
          Net revenue in {series.currency} by month, last 12 months
        </caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {series.months.map((point) => (
            <tr key={point.month}>
              <th scope="row">{point.month}</th>
              <td>{formatMoney(point.amount, series.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div aria-hidden="true">
        <div className="flex h-28 items-end gap-1.5">
          {series.months.map((point) => (
            <div key={point.month} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <div
                className="w-full rounded-sm bg-[color-mix(in_srgb,var(--color-primary)_70%,transparent)] transition-colors hover:bg-[var(--color-primary)]"
                style={{ height: `${Math.max(point.amount <= 0 ? 1 : 4, (point.amount / max) * 100)}%` }}
                title={`${point.month}: ${formatMoney(point.amount, series.currency)}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-1.5">
          {series.months.map((point) => (
            <span key={point.month} className="flex-1 truncate text-center text-[10px] text-[var(--color-muted-fg)]">
              {monthLabel(point.month)}
            </span>
          ))}
        </div>
      </div>
      {series.total === 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted-fg)]">
          No settled revenue in {series.currency} yet. Verified payments chart here month by month.
        </p>
      )}
    </div>
  );
}
