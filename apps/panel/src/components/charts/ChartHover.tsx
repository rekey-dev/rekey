'use client';

import * as React from 'react';

export interface HoverPoint {
  label: string;
  rows: Array<{ name: string; value: string; color: string; dashed?: boolean }>;
}

/**
 * Hover and keyboard read-out for a chart whose x axis is a run of equal
 * slots (days, weeks). It only lays invisible columns over the plot and shows
 * the values it was handed, so the chart stays a server component and nothing
 * here fetches.
 *
 * Arrow keys move between slots once the chart has focus, so the values are
 * reachable without a mouse; the table toggle covers screen readers.
 */
export function ChartHover({ points, label }: { points: HoverPoint[]; label: string }): React.JSX.Element {
  const [active, setActive] = React.useState<number | null>(null);
  const n = points.length;
  const point = active === null ? null : points[active];

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setActive((cur) => {
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return n - 1;
      const from = cur ?? (e.key === 'ArrowLeft' ? n : -1);
      return Math.min(n - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1)));
    });
  };

  return (
    <div
      className="absolute inset-0 flex rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use the arrow keys to read each point.`}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
    >
      {points.map((p, i) => (
        <div
          key={p.label}
          className={`h-full flex-1 ${active === i ? 'bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]' : ''}`}
          onMouseEnter={() => setActive(i)}
        />
      ))}
      {point && active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-10 min-w-[8rem] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs shadow-sm"
          style={
            active / n > 0.55
              ? { right: `${100 - ((active + 0.5) / n) * 100}%`, marginRight: 8 }
              : { left: `${((active + 0.5) / n) * 100}%`, marginLeft: 8 }
          }
        >
          <p className="mb-1 font-medium text-[var(--color-fg)]">{point.label}</p>
          {point.rows.map((r) => (
            <p key={r.name} className="flex items-center justify-between gap-3 text-[var(--color-muted-fg)]">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-3"
                  style={{
                    background: r.dashed ? 'transparent' : r.color,
                    borderTop: r.dashed ? `2px dashed ${r.color}` : undefined,
                  }}
                />
                {r.name}
              </span>
              <span className="tabular-nums text-[var(--color-fg)]">{r.value}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
