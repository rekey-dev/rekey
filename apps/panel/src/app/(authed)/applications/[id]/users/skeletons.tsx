import * as React from 'react';

function Bar({ className = '' }: { className?: string }): React.JSX.Element {
  return <div className={`rounded bg-[var(--color-surface-muted)] ${className}`} />;
}

function Box({ className = '', children }: { className?: string; children?: React.ReactNode }): React.JSX.Element {
  return <div className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 ${className}`}>{children}</div>;
}

/** The KPI row and the activity charts, the same shapes as the real thing. */
export function TopSkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading the key numbers" className="animate-pulse space-y-5">
      <Bar className="h-3 w-72" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <Bar className="h-3 w-20" />
            <Bar className="h-6 w-16" />
            <Bar className="h-3 w-24" />
          </div>
        ))}
      </div>
      <Box>
        <Bar className="mb-4 h-4 w-32" />
        <Bar className="h-48 w-full" />
      </Box>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Box key={i}>
            <Bar className="mb-4 h-4 w-40" />
            <Bar className="h-40 w-full" />
          </Box>
        ))}
      </div>
    </div>
  );
}

/** The breakdowns, funnel, retention and health sections. */
export function RestSkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading the breakdowns" className="animate-pulse space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Box key={i} className="space-y-2.5">
            <Bar className="mb-2 h-4 w-24" />
            {Array.from({ length: 5 }, (_, j) => (
              <Bar key={j} className="h-6 w-full" />
            ))}
          </Box>
        ))}
      </div>
      <Box>
        <Bar className="mb-4 h-4 w-36" />
        <Bar className="h-36 w-full" />
      </Box>
      <Box>
        <Bar className="mb-4 h-4 w-44" />
        <Bar className="h-48 w-full" />
      </Box>
    </div>
  );
}

