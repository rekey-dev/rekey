import * as React from 'react';

/**
 * Loading skeletons for route-level `loading.tsx` boundaries (WP15).
 *
 * Pure server components — no JS shipped. Uses the design-token surfaces
 * + `animate-pulse` so the placeholder reads correctly in both themes.
 * Shapes intentionally mirror the real layouts (page title, table rows,
 * stat cards) so the swap-in doesn't jump.
 */

function Bar({ className = '' }: { className?: string }): React.JSX.Element {
  return <div className={`rounded bg-[var(--color-surface-muted)] dark:bg-neutral-800 ${className}`} />;
}

/** Title + subtitle placeholder matching PageHeader. */
export function HeaderSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Bar className="h-6 w-48" />
      <Bar className="h-3.5 w-72" />
    </div>
  );
}

/** A bordered table with a header row + `rows` body rows. */
export function TableSkeleton({ rows = 6 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-2.5">
        <Bar className="h-3.5 w-1/3" />
      </div>
      <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-6 px-4 py-3">
            <Bar className="h-3.5 w-1/4" />
            <Bar className="h-3.5 w-1/6" />
            <Bar className="h-3.5 w-1/5" />
            <Bar className="ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A grid of stat-card placeholders. */
export function CardSkeleton({ cards = 3 }: { cards?: number }): React.JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <Bar className="h-3 w-20" />
          <Bar className="h-6 w-16" />
          <Bar className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

/** Generic full-page skeleton: header + table. Default for loading.tsx. */
export function PageSkeleton(): React.JSX.Element {
  return (
    <section aria-busy="true" aria-label="Loading" className="mx-auto max-w-7xl animate-pulse space-y-6 px-6 py-8 lg:px-8">
      <HeaderSkeleton />
      <TableSkeleton />
    </section>
  );
}
