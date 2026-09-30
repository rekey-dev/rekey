import * as React from 'react';

/**
 * The data behind a chart as a real table, behind a "View as table" toggle.
 * A `<details>` element, so it works without JavaScript and a screen reader
 * announces it as a disclosure. Every chart renders one.
 *
 * @example
 * <ChartTable caption="Daily active users" columns={['Date', 'DAU']} rows={[['2026-09-29', '12']]} />
 */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Array<React.ReactNode>>;
}): React.JSX.Element {
  return (
    <details className="group/table mt-2 text-xs">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]">
        <span aria-hidden="true" className="inline-block transition-transform group-open/table:rotate-90">
          ›
        </span>
        View as table
      </summary>
      <div className="relative mt-2 max-h-72 overflow-auto rounded-md border border-[var(--color-border)]">
        <table className="w-full border-collapse text-left tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-[var(--color-surface-muted)]">
            <tr>
              {columns.map((c, i) => (
                <th key={c} scope="col" className={`px-3 py-1.5 font-medium ${i > 0 ? 'text-right' : ''}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-[var(--color-border)]">
                {r.map((cell, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="px-3 py-1 font-normal">
                      {cell}
                    </th>
                  ) : (
                    <td key={j} className="px-3 py-1 text-right">
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
