import * as React from 'react';
import { formatCount, formatExact, formatShare } from '@/lib/metric-format';

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  /** A side branch drawn under its step, e.g. "Skipped" beside "Completed". */
  branch?: { label: string; count: number } | undefined;
}

/**
 * Step bars, each as wide as its share of the first step, with the
 * conversion from the step before and from the start. An ordered list, so
 * the order is announced and the numbers are text.
 *
 * @example
 * <Funnel title="Onboarding" steps={[{ key: 'created', label: 'Created', count: 100 }, { key: 'verified', label: 'Verified', count: 72 }]} />
 */
export function Funnel({ title, steps }: { title: string; steps: FunnelStep[] }): React.JSX.Element {
  const first = steps[0]?.count ?? 0;
  return (
    <ol aria-label={title} className="space-y-2.5">
      {steps.map((s, i) => {
        const prev = i === 0 ? null : steps[i - 1]!.count;
        const ofStart = first > 0 ? s.count / first : 0;
        // Steps need not nest (a user can sign in without verifying), so a share
        // of the previous step over 100% says nothing and is not shown.
        const ofPrev = prev && s.count <= prev ? s.count / prev : null;
        return (
          <li key={s.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 text-[var(--color-fg)]">{s.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted-fg)]">
                <span className="text-sm font-medium text-[var(--color-fg)]" title={formatExact(s.count)}>
                  {formatCount(s.count)}
                </span>
                {i > 0 && (
                  <>
                    {ofPrev !== null && <span className="ml-2">{formatShare(ofPrev)} of previous</span>}
                    <span className="ml-2 hidden sm:inline">{formatShare(ofStart)} of all</span>
                  </>
                )}
              </span>
            </div>
            <div className="mt-1 h-2.5 rounded-full bg-[var(--color-surface-muted)]" aria-hidden="true">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${first > 0 ? Math.max(s.count > 0 ? 1 : 0, ofStart * 100) : 0}%`,
                  background: `color-mix(in srgb, var(--chart-1) ${Math.round(100 - i * 12)}%, transparent)`,
                }}
              />
            </div>
            {s.branch && (
              <p className="mt-1 pl-3 text-xs text-[var(--color-muted-fg)]">
                <span aria-hidden="true">↳ </span>
                {s.branch.label}: <span className="tabular-nums text-[var(--color-fg)]">{formatCount(s.branch.count)}</span>
                {first > 0 && <span className="ml-1">({formatShare(s.branch.count / first)} of all)</span>}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
