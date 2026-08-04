import * as React from 'react';
import Link from 'next/link';

/** Page sizes offered by the per-page selector. */
export const PAGE_SIZES = [10, 25, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

type SearchParams = Record<string, string | string[] | undefined>;

/** Resolve the page size from `?ps=`, clamped to the allowed set (else default). */
export function readPageSize(sp: SearchParams): number {
  const raw = typeof sp.ps === 'string' ? parseInt(sp.ps, 10) : NaN;
  return (PAGE_SIZES as readonly number[]).includes(raw) ? raw : DEFAULT_PAGE_SIZE;
}

/** Resolve the offset from `?offset=` (>= 0). */
export function readOffset(sp: SearchParams): number {
  return typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
}

/**
 * Offset Prev/Next control + a 10/25/100 per-page selector for operator list
 * pages. Renders nothing when the list fits on a single first page (nothing to
 * page or resize meaningfully).
 *
 * `hasMore` is required, and it is the API's answer. Every paginated tenant
 * list endpoint returns `{ items, page: { total, limit, offset, hasMore } }`,
 * so the caller reads `page.hasMore` off the response and passes it straight
 * through (`lib/paginate.ts`). This component neither guesses nor infers.
 *
 * It used to do both, in turn: first `count === pageSize`, which is wrong for
 * every result set that is an exact multiple of the page size — 25 rows at
 * 25/page rendered a "Next →" onto a page that said "No results" — and then an
 * over-fetch of one extra row, which was correct but could not work at the
 * 100/page size the API caps `limit` at. Both are gone.
 *
 * `extraParams` preserves other query state (e.g. a search term); the current
 * page size (`ps`) is preserved automatically across nav links.
 */
export function Pager({
  basePath,
  offset,
  pageSize,
  count,
  hasMore,
  extraParams,
}: {
  basePath: string;
  offset: number;
  pageSize: number;
  /** Rows actually rendered on this page — drives the "Showing 1–25" label. */
  count: number;
  /** True when a further page exists — the API's `page.hasMore`. */
  hasMore: boolean;
  extraParams?: Record<string, string>;
}): React.JSX.Element | null {
  if (offset === 0 && !hasMore) return null;

  const link = (next: { offset?: number; ps?: number }): string => {
    const p = new URLSearchParams(extraParams ?? {});
    const o = next.offset ?? offset;
    const ps = next.ps ?? pageSize;
    if (o > 0) p.set('offset', String(o));
    else p.delete('offset');
    if (ps !== DEFAULT_PAGE_SIZE) p.set('ps', String(ps));
    else p.delete('ps');
    const s = p.toString();
    return `${basePath}${s ? `?${s}` : ''}`;
  };

  const btn =
    'rounded-md border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-surface-muted)]';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm pt-1">
      <div className="flex items-center gap-2">
        {offset > 0 && (
          <Link href={link({ offset: Math.max(0, offset - pageSize) })} className={btn}>
            ← Previous
          </Link>
        )}
        {hasMore && (
          <Link href={link({ offset: offset + pageSize })} className={btn}>
            Next →
          </Link>
        )}
        <span className="text-xs text-[var(--color-muted-fg)]">
          {count === 0 ? 'No results' : `Showing ${offset + 1}–${offset + count}`}
        </span>
      </div>
      <div className="flex items-center gap-1 text-xs text-[var(--color-muted-fg)]">
        <span className="mr-1">Per page</span>
        {PAGE_SIZES.map((n) => (
          <Link
            key={n}
            href={link({ ps: n, offset: 0 })}
            aria-current={n === pageSize ? 'true' : undefined}
            className={
              n === pageSize
                ? 'rounded px-2 py-1 bg-[var(--color-surface-muted)] text-[var(--color-fg)] font-medium'
                : 'rounded px-2 py-1 hover:bg-[var(--color-surface-muted)]'
            }
          >
            {n}
          </Link>
        ))}
      </div>
    </div>
  );
}
