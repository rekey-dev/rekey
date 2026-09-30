import * as React from 'react';
import { HeaderSkeleton } from '@/components/Skeleton';

const bar = 'rounded bg-[var(--color-surface-muted)] dark:bg-neutral-800';

/** Mirrors the list: toolbar, then table rows from `md` up and cards below. */
export default function Loading(): React.JSX.Element {
  return (
    <section aria-busy="true" aria-label="Loading" className="mx-auto max-w-7xl animate-pulse space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <HeaderSkeleton />
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className={`h-8 w-full sm:w-64 ${bar}`} />
        <div className={`h-8 w-full sm:w-40 ${bar}`} />
      </div>
      <div className="hidden overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] md:block">
        <div className="h-9 bg-[var(--color-surface-muted)]" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-6 border-t border-[var(--color-border)] px-4 py-3.5">
            <div className="w-56 space-y-1.5">
              <div className={`h-3.5 w-40 ${bar}`} />
              <div className={`h-2.5 w-28 ${bar}`} />
            </div>
            <div className={`h-5 w-20 ${bar}`} />
            <div className={`h-5 w-16 ${bar}`} />
            <div className={`h-3 w-14 ${bar}`} />
            <div className={`ml-auto h-3 w-20 ${bar}`} />
          </div>
        ))}
      </div>
      <div className="space-y-2 md:hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
            <div className={`h-3.5 w-40 ${bar}`} />
            <div className={`h-2.5 w-28 ${bar}`} />
            <div className={`h-2.5 w-52 ${bar}`} />
          </div>
        ))}
      </div>
    </section>
  );
}
