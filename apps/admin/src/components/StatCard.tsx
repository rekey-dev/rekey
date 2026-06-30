import * as React from 'react';

/**
 * KPI tile — big number, label, optional sublabel/delta. Used on the overview
 * grid and at the top of detail pages. Read-only display only; clicking does
 * nothing unless wrapped in a <Link>.
 */
export function StatCard({
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
}): React.JSX.Element {
  const valueColor =
    tone === 'positive'
      ? 'text-[var(--color-success)]'
      : tone === 'warning'
        ? 'text-[var(--color-warning)]'
        : tone === 'danger'
          ? 'text-[var(--color-danger)]'
          : 'text-[var(--color-fg)]';
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">{label}</p>
      <p className={`mt-1 font-feature text-2xl font-semibold tabular-nums ${valueColor}`} style={{ fontFamily: 'var(--font-feature), ui-serif, Georgia, serif' }}>
        {value}
      </p>
      {sublabel !== undefined && (
        <p className="mt-1 text-xs text-[var(--color-muted-fg)]">{sublabel}</p>
      )}
    </div>
  );
}
