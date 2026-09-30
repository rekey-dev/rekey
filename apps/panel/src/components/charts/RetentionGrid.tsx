import * as React from 'react';
import { formatCount, formatShare } from '@/lib/metric-format';
import { shortDate } from './LineChart';

export interface RetentionCohort {
  /** Monday of the sign-up week, YYYY-MM-DD. */
  week: string;
  size: number;
  /** Retained share per week offset; null where the week has not happened or is outside the data. */
  retained: Array<number | null>;
}

/**
 * Weekly cohorts as an HTML table: rows are sign-up weeks, columns are weeks
 * since. The cell tint is the share, on the brand colour. Scrolls sideways
 * inside its own box on a phone; the page never does.
 *
 * @example
 * <RetentionGrid title="Weekly retention" cohorts={[{ week: '2026-09-07', size: 40, retained: [1, 0.4, null] }]} />
 */
export function RetentionGrid({
  title,
  cohorts,
  weeks,
}: {
  title: string;
  cohorts: RetentionCohort[];
  /** Columns to draw, week 0 included. */
  weeks: number;
}): React.JSX.Element {
  return (
    <div className="relative -mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[34rem] border-separate border-spacing-[2px] text-xs tabular-nums">
        <caption className="sr-only">{title}. Each cell is the share of that week&apos;s sign-ups active in a later week.</caption>
        <thead>
          <tr className="text-[var(--color-muted-fg)]">
            <th scope="col" className="px-2 py-1 text-left font-medium">
              Signed up
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Users
            </th>
            {Array.from({ length: weeks }, (_, k) => (
              <th key={k} scope="col" className="px-1 py-1 text-center font-medium">
                {k === 0 ? 'Week 0' : `+${k}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.week}>
              <th scope="row" className="whitespace-nowrap px-2 py-1 text-left font-normal text-[var(--color-fg)]">
                {shortDate(c.week)}
              </th>
              <td className="px-2 py-1 text-right text-[var(--color-muted-fg)]">{formatCount(c.size)}</td>
              {Array.from({ length: weeks }, (_, k) => {
                const v = c.retained[k];
                if (v === null || v === undefined) {
                  return (
                    <td key={k} className="rounded px-1 py-1 text-center text-[var(--color-faint-fg)]">
                      <span className="sr-only">no data</span>
                    </td>
                  );
                }
                const pct = Math.round(v * 100);
                return (
                  <td
                    key={k}
                    className={`rounded px-1 py-1 text-center ${pct >= 55 ? 'text-[var(--color-primary-fg)]' : 'text-[var(--color-fg)]'}`}
                    style={{ background: `color-mix(in srgb, var(--color-primary) ${Math.max(4, pct)}%, transparent)` }}
                  >
                    {formatShare(v).replace('.0%', '%')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
