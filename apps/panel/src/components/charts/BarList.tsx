import * as React from 'react';
import { OTHER_COLOR } from '@/lib/chart-scale';
import { formatCount, formatExact, formatShare } from '@/lib/metric-format';

export interface BarListItem {
  key: string;
  label: string;
  /** Null when the API suppressed a small cell; the row says so instead of a number. */
  count: number | null;
  share: number | null;
}

/**
 * Horizontal bars for a breakdown, largest first, then "Other" and "Unknown".
 * Easier to compare than a donut, and it fits a phone. The list is the data,
 * so screen readers read it as text; no separate table is needed.
 *
 * @example
 * <BarList title="Platform" items={[{ key: 'ios', label: 'iOS', count: 40, share: 0.4 }]} />
 */
export function BarList({
  title,
  items,
  other,
  unknown,
  limit = 8,
}: {
  title: string;
  items: BarListItem[];
  other?: { count: number; share: number } | null | undefined;
  unknown?: { count: number; share: number } | null | undefined;
  limit?: number;
}): React.JSX.Element {
  const shown = items.slice(0, limit);
  const overflow = items.slice(limit);
  const extraOther = overflow.reduce(
    (acc, it) => ({ count: acc.count + (it.count ?? 0), share: acc.share + (it.share ?? 0) }),
    { count: 0, share: 0 },
  );
  const otherRow =
    other || overflow.length
      ? { count: (other?.count ?? 0) + extraOther.count, share: (other?.share ?? 0) + extraOther.share }
      : null;
  const rows: Array<BarListItem & { muted?: boolean }> = [
    ...shown,
    ...(otherRow && otherRow.count > 0 ? [{ key: '__other', label: 'Other', ...otherRow, muted: true }] : []),
    ...(unknown && unknown.count > 0 ? [{ key: '__unknown', label: 'Unknown', ...unknown, muted: true }] : []),
  ];
  const top = Math.max(0, ...rows.map((r) => r.share ?? 0));

  return (
    <ul aria-label={title} className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="relative flex items-center justify-between gap-3 rounded px-2 py-1 text-sm">
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 rounded"
            style={{
              width: `${r.share === null || top === 0 ? 0 : Math.max(1.5, (r.share / top) * 100)}%`,
              background: r.muted
                ? `color-mix(in srgb, ${OTHER_COLOR} 22%, transparent)`
                : 'color-mix(in srgb, var(--chart-1) 16%, transparent)',
            }}
          />
          <span className={`relative min-w-0 truncate ${r.muted ? 'text-[var(--color-muted-fg)]' : 'text-[var(--color-fg)]'}`}>
            {r.label}
          </span>
          <span className="relative shrink-0 text-xs tabular-nums text-[var(--color-muted-fg)]">
            {r.count === null ? (
              <span title="Fewer than 5. Exact small counts need end-user read access.">fewer than 5</span>
            ) : (
              <>
                <span className="text-[var(--color-fg)]" title={formatExact(r.count)}>
                  {formatCount(r.count)}
                </span>
                {r.share !== null && <span className="ml-2 inline-block w-12 text-right">{formatShare(r.share)}</span>}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
