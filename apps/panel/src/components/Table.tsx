import * as React from 'react';
import Link from 'next/link';

/**
 * Table primitives for operator list views. Replaces the hand-rolled
 * `<table className="w-full text-sm">` + `<thead className="bg-surface-muted…">`
 * block duplicated across ~17 pages, each with slightly different padding,
 * divider colors, and header styling.
 *
 * Design goals (dense-but-breathable):
 *  - Roomier cells: px-4 py-3 (was py-2 / py-2.5).
 *  - Sticky header by default so column labels survive long scrolls; the
 *    header is a small-caps, tracked label for scannability.
 *  - Subtle zebra striping + row hover so the eye can track a row across many
 *    columns without heavy rules between every row.
 *  - Token-based borders/surfaces only — no hardcoded neutral-* colors.
 *
 * Composition:
 *   <Table>
 *     <THead>
 *       <TR><TH>Email</TH><TH align="right">Actions</TH></TR>
 *     </THead>
 *     <TBody>
 *       {rows.map(r => <TR key={r.id}><TD>…</TD><TD align="right">…</TD></TR>)}
 *     </TBody>
 *   </Table>
 *
 * The outer scroll container + card shell is built in; just render <Table>.
 */

type Align = 'left' | 'right' | 'center';

const ALIGN: Record<Align, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function Table({
  children,
  className = '',
  minWidth,
}: {
  children: React.ReactNode;
  className?: string;
  /** Optional min-width (e.g. "min-w-[48rem]") to force horizontal scroll on narrow viewports. */
  minWidth?: string;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className={['w-full border-collapse text-sm', minWidth ?? '', className].filter(Boolean).join(' ')}>
        {children}
      </table>
    </div>
  );
}

export function THead({
  children,
  sticky = true,
}: {
  children: React.ReactNode;
  sticky?: boolean;
}): React.JSX.Element {
  return (
    <thead
      className={[
        'bg-[var(--color-surface-muted)] text-[var(--color-muted-fg)]',
        sticky ? 'sticky top-0 z-10' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Zebra striping on body rows; the header keeps its own muted surface.
  return <tbody className="[&>tr:nth-child(even)]:bg-[var(--color-surface-muted)]/40">{children}</tbody>;
}

export function TR({
  children,
  className = '',
  hover = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** Body rows opt into a hover highlight; header rows leave it off. */
  hover?: boolean;
}): React.JSX.Element {
  return (
    <tr
      className={[
        'border-b border-[var(--color-border)] last:border-0 align-middle transition-colors',
        hover ? 'hover:bg-[var(--color-surface-muted)]/70' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </tr>
  );
}

// ─── Sortable headers ────────────────────────────────────────────────
//
// Server-component friendly (like the Pager): the header is a plain <Link>
// that flips ?sort/?order query params — no client JS. Pages read the params
// with `readSort` (allowlist-validated), pass them through to the API, and
// hand each sortable <TH> the next-state href from `sortToggleHref`.
// Click cycle per column: unsorted → asc → desc → unsorted (server default).

export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string = string> {
  sort: K;
  order: SortDir;
}

/** Read ?sort/?order from searchParams, validated against the column allowlist. */
export function readSort<K extends string>(
  sp: Record<string, string | string[] | undefined>,
  allowed: readonly K[],
): SortState<K> | null {
  const sort =
    typeof sp.sort === 'string' && (allowed as readonly string[]).includes(sp.sort)
      ? (sp.sort as K)
      : null;
  if (!sort) return null;
  return { sort, order: sp.order === 'desc' ? 'desc' : 'asc' };
}

/**
 * Build the `sort` prop for one sortable <TH>: the column's current direction
 * (null when this column isn't the active sort) plus the href that advances it
 * to the next cycle state. `extraParams` preserves filters/page-size; offset is
 * deliberately dropped — re-sorting restarts at page 1.
 */
export function sortToggleHref({
  basePath,
  column,
  current,
  extraParams,
}: {
  basePath: string;
  column: string;
  current: SortState | null;
  extraParams?: Record<string, string>;
}): { dir: SortDir | null; href: string } {
  const dir = current?.sort === column ? current.order : null;
  const p = new URLSearchParams(extraParams ?? {});
  if (dir === null) {
    p.set('sort', column);
    p.set('order', 'asc');
  } else if (dir === 'asc') {
    p.set('sort', column);
    p.set('order', 'desc');
  }
  // dir === 'desc' → params cleared → back to the server default order.
  const s = p.toString();
  return { dir, href: `${basePath}${s ? `?${s}` : ''}` };
}

export function TH({
  children,
  align = 'left',
  className = '',
  scope = 'col',
  sort,
}: {
  children?: React.ReactNode;
  align?: Align;
  className?: string;
  scope?: 'col' | 'row';
  /** Optional sortable affordance — pass the result of `sortToggleHref`. */
  sort?: { dir: SortDir | null; href: string };
}): React.JSX.Element {
  return (
    <th
      scope={scope}
      aria-sort={sort?.dir === 'asc' ? 'ascending' : sort?.dir === 'desc' ? 'descending' : undefined}
      className={[
        'whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider',
        ALIGN[align],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {sort ? (
        <Link
          href={sort.href}
          className={[
            'group inline-flex items-center gap-1 rounded hover:text-[var(--color-fg)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50',
            sort.dir ? 'text-[var(--color-fg)]' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {children}
          <span
            aria-hidden="true"
            className={sort.dir ? '' : 'opacity-0 transition-opacity group-hover:opacity-50'}
          >
            {sort.dir === 'desc' ? '↓' : '↑'}
          </span>
        </Link>
      ) : (
        children
      )}
    </th>
  );
}

export function TD({
  children,
  align = 'left',
  className = '',
  muted = false,
  mono = false,
  colSpan,
  title,
}: {
  children?: React.ReactNode;
  align?: Align;
  className?: string;
  /** Convenience: render the cell in muted-fg (secondary data like ids/dates). */
  muted?: boolean;
  /** Convenience: monospace (ids, slugs, keys). */
  mono?: boolean;
  colSpan?: number;
  /** Tooltip — pass the full value when the cell content is truncated. */
  title?: string;
}): React.JSX.Element {
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={[
        'px-4 py-3',
        ALIGN[align],
        muted ? 'text-[var(--color-muted-fg)]' : 'text-[var(--color-fg)]',
        mono ? 'font-mono text-xs' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </td>
  );
}
