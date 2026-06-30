import * as React from 'react';
import { HeaderSkeleton } from '@/components/Skeleton';

/** Applications list renders cards, not a table — mirror that shape. */
export default function Loading(): React.JSX.Element {
  return (
    <section aria-busy="true" aria-label="Loading" className="mx-auto max-w-7xl animate-pulse space-y-6 px-6 py-8 lg:px-8">
      <HeaderSkeleton />
      <div className="space-y-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4"
          >
            <div className="space-y-2">
              <div className="h-4 w-40 rounded bg-[var(--color-surface-muted)] dark:bg-neutral-800" />
              <div className="h-3 w-24 rounded bg-[var(--color-surface-muted)] dark:bg-neutral-800" />
            </div>
            <div className="h-3 w-16 rounded bg-[var(--color-surface-muted)] dark:bg-neutral-800" />
          </div>
        ))}
      </div>
    </section>
  );
}
