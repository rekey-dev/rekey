import * as React from 'react';

/**
 * Lightweight presentational table — server-rendered, no client JS, no sort.
 * Read-only display only. Columns are declared inline by the page; the table
 * just hands them cells with consistent typography.
 */
export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

export function DataTable<T>({
  rows,
  columns,
  emptyMessage = 'No data.',
  getKey,
  footerNote,
}: {
  rows: T[];
  columns: Column<T>[];
  emptyMessage?: string;
  getKey: (row: T, index: number) => string;
  /**
   * Optional footer hint. When omitted, the table footer just shows the row
   * count. When set, the hint renders on the right (use this for "Showing X
   * of Y" / "Older rows not displayed" callouts on capped lists).
   */
  footerNote?: React.ReactNode;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted-fg)]">
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">
              {columns.map((col, i) => (
                <th
                  key={col.key}
                  className={
                    `px-4 py-2.5 ${col.align === 'right' ? 'text-right' : ''} ${col.className ?? ''} ` +
                    // Sticky first column keeps the row identity visible while the
                    // operator scrolls right through wide tables (audit / requests
                    // / billing have 6+ columns of cuids).
                    (i === 0
                      ? 'sticky left-0 z-10 bg-[var(--color-surface)] shadow-[inset_-1px_0_0_var(--color-border)]'
                      : '')
                  }
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={getKey(row, ri)}
                className="group border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-surface-muted)]"
              >
                {columns.map((col, ci) => (
                  <td
                    key={col.key}
                    className={
                      `px-4 py-2.5 align-top ${col.align === 'right' ? 'text-right tabular-nums' : ''} ${col.className ?? ''} ` +
                      // Matches the header sticky; uses surface-on-hover so the
                      // hover effect still reads on the pinned column.
                      (ci === 0
                        ? 'sticky left-0 z-10 bg-[var(--color-surface)] group-hover:bg-[var(--color-surface-muted)] shadow-[inset_-1px_0_0_var(--color-border)]'
                        : '')
                    }
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-muted-fg)]">
        <span>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</span>
        {footerNote && <span>{footerNote}</span>}
      </div>
    </div>
  );
}
