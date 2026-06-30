import * as React from 'react';
import { fmtCount } from '@/lib/format';

/**
 * Server-rendered, link-based pager. No client JS — every control is an
 * `<a href>` built by the page's `buildHref(page)` (which preserves the
 * current search / sort / filter params). The page reads its 1-based page
 * number out of `searchParams` and converts it to an `offset` for the API.
 *
 * Renders nothing when there's only one page of data — the `<DataTable/>`
 * footer already shows the row count in that case.
 */
export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
  cap,
  capReason,
  className = '',
}: {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** Full count of matching rows (not just this page). */
  total: number;
  /** Maps a 1-based page number to an href. */
  buildHref: (page: number) => string;
  /**
   * Max rows actually reachable via navigation. When set and below `total`,
   * page nav stops at `cap` even though `total` is larger — used for COMPUTED
   * sorts (MRR, etc.) where the API only ranks the first N rows. The summary
   * still shows the honest `total`; the cap note explains the gap.
   */
  cap?: number;
  /** Tooltip on the cap note explaining why nav stops short of `total`. */
  capReason?: string;
  className?: string;
}): React.JSX.Element | null {
  const reachable = cap !== undefined ? Math.min(total, cap) : total;
  const totalPages = Math.max(1, Math.ceil(reachable / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const capped = cap !== undefined && total > cap;
  // Single page and not capped → nothing to navigate.
  if (total <= pageSize && current === 1 && !capped) return null;

  const start = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, reachable);

  return (
    <nav className={`flex flex-wrap items-center justify-between gap-3 ${className}`} aria-label="Pagination">
      <p className="text-xs text-[var(--color-muted-fg)]">
        Showing <span className="tabular-nums">{fmtCount(start)}</span>–
        <span className="tabular-nums">{fmtCount(end)}</span> of{' '}
        <span className="tabular-nums">{fmtCount(total)}</span>
        {capped && (
          <span
            className="ml-1 text-[var(--color-faint-fg)]"
            title={capReason ?? `This sort only ranks the first ${fmtCount(cap!)} rows.`}
          >
            · first {fmtCount(cap!)} navigable
          </span>
        )}
      </p>
      <div className="flex items-center gap-1">
        <PageLink href={buildHref(1)} disabled={current === 1} label="First page">«</PageLink>
        <PageLink href={buildHref(current - 1)} disabled={current === 1} label="Previous page">‹ Prev</PageLink>
        <span className="px-2 text-xs tabular-nums text-[var(--color-muted-fg)]">
          Page {current} / {totalPages}
        </span>
        <PageLink href={buildHref(current + 1)} disabled={current >= totalPages} label="Next page">Next ›</PageLink>
        <PageLink href={buildHref(totalPages)} disabled={current >= totalPages} label="Last page">»</PageLink>
      </div>
    </nav>
  );
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const base =
    'inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium transition-colors';
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={`${base} cursor-not-allowed border-[var(--color-border)] text-[var(--color-faint-fg)] opacity-60`}
      >
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      aria-label={label}
      className={`${base} border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40`}
    >
      {children}
    </a>
  );
}
