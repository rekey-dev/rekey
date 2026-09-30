import * as React from 'react';
import Link from '@/components/Link';

/**
 * A change against the previous period. `good` says whether the direction is
 * good news for this metric, so an at-risk count going up reads as bad.
 * `null` renders "n/a" with `reason` as the tooltip.
 */
export interface StatDelta {
  text: string;
  direction: 'up' | 'down' | 'flat';
  good: boolean | null;
  reason?: string;
}

/**
 * The one metric tile. Links to the tab that holds the detail when `href` is
 * set; without it the tile is plain text, which is how a tile renders for a
 * caller who cannot open that tab.
 *
 * @example
 * <StatTile title="End-users" value="1,204" footer="12 new this week" href="/applications/a/end-users" />
 */
export function StatTile({
  title,
  value,
  valueTitle,
  footer,
  href,
  chart,
  children,
  tone,
  muted = false,
  delta,
  className = '',
}: {
  title: string;
  value: string;
  /** The exact value, shown on hover when `value` is abbreviated. */
  valueTitle?: string | undefined;
  footer?: React.ReactNode;
  href?: string | null | undefined;
  /** Drawn to the right of the value, for a sparkline. */
  chart?: React.ReactNode;
  /** Drawn between the value and the footer. */
  children?: React.ReactNode;
  tone?: 'warn' | undefined;
  muted?: boolean;
  delta?: StatDelta | null | undefined;
  className?: string;
}): React.JSX.Element {
  const body = (
    <>
      <span className="text-xs text-[var(--color-muted-fg)]">{title}</span>
      <span className="flex min-w-0 items-end justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={`truncate text-2xl font-semibold tabular-nums ${
              tone === 'warn'
                ? 'text-amber-600 dark:text-amber-500'
                : muted
                  ? 'text-[var(--color-muted-fg)]'
                  : 'text-[var(--color-fg)]'
            }`}
            title={valueTitle ?? value}
          >
            {value}
          </span>
          {delta !== undefined && <DeltaBadge delta={delta} />}
        </span>
        {chart && <span className="w-20 shrink-0 pb-1">{chart}</span>}
      </span>
      {children}
      {footer !== undefined && (
        <span className="text-xs leading-snug text-[var(--color-muted-fg)]">{footer}</span>
      )}
    </>
  );
  const shell = `group flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${className}`;
  if (!href) return <div className={shell}>{body}</div>;
  return (
    <Link
      href={href}
      className={`${shell} transition-colors hover:border-[var(--color-faint-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]`}
    >
      {body}
    </Link>
  );
}

const ARROW: Record<StatDelta['direction'], string> = { up: '↑', down: '↓', flat: '→' };

export function DeltaBadge({ delta }: { delta: StatDelta | null }): React.JSX.Element {
  if (delta === null) {
    return <span className="text-xs text-[var(--color-faint-fg)]">n/a</span>;
  }
  const colour =
    delta.good === null || delta.direction === 'flat'
      ? 'text-[var(--color-muted-fg)]'
      : delta.good
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-red-700 dark:text-red-400';
  return (
    <span className={`whitespace-nowrap text-xs font-medium tabular-nums ${colour}`} title={delta.reason}>
      <span aria-hidden="true">{ARROW[delta.direction]} </span>
      {delta.text}
    </span>
  );
}
