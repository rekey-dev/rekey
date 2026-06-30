import * as React from 'react';

/**
 * Server-rendered search input — POSTs nothing, GETs everything as a query
 * string. Plain `<form method="get">` over a single text input, no client
 * JS. Submitting reloads the page with `?q=...` in the URL; the page's
 * server component reads `searchParams` and forwards `q` to the admin API.
 *
 * Other filters can be passed through as hidden inputs so they survive the
 * submit (e.g. status pills + free-text search on the same page).
 */
export function SearchForm({
  initialValue,
  placeholder = 'Search…',
  name = 'q',
  hidden,
  className = '',
}: {
  initialValue?: string;
  placeholder?: string;
  name?: string;
  /** Extra params to preserve when this form submits. */
  hidden?: Record<string, string | undefined>;
  className?: string;
}): React.JSX.Element {
  return (
    <form method="get" className={`flex items-center gap-2 ${className}`}>
      <input
        type="search"
        name={name}
        defaultValue={initialValue ?? ''}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
      />
      {hidden &&
        Object.entries(hidden)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button
        type="submit"
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
      >
        Search
      </button>
      {initialValue ? (
        <a
          href="?"
          className="text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
        >
          Clear
        </a>
      ) : null}
    </form>
  );
}

/**
 * Filter chips that swap a query-string param. Renders one `<Link>` per
 * option; the active one styles as the surface-muted background.
 *
 * Use for low-cardinality enums (subscription status, actor type, etc.). The
 * "All" chip is implicit — pass `undefined` as the active value and the
 * "All" chip will render selected.
 */
export function FilterChips({
  label,
  options,
  active,
  buildHref,
  className = '',
}: {
  label: React.ReactNode;
  options: Array<{ value: string; label: React.ReactNode }>;
  active: string | undefined;
  /** Receives the chosen value (or undefined for "All") and returns the link href. */
  buildHref: (value: string | undefined) => string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">
        {label}
      </span>
      <div className="inline-flex flex-wrap items-center gap-1">
        <Chip href={buildHref(undefined)} active={active === undefined}>
          All
        </Chip>
        {options.map((o) => (
          <Chip key={o.value} href={buildHref(o.value)} active={active === o.value}>
            {o.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <a
      href={href}
      aria-current={active ? 'true' : undefined}
      className={
        'rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ' +
        (active
          ? 'border-[var(--color-primary)]/30 bg-[var(--color-primary-soft)] text-[var(--color-primary-soft-fg)]'
          : 'border-[var(--color-border)] text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]')
      }
    >
      {children}
    </a>
  );
}

/**
 * Build a query-string from a record, dropping empty values. Used by page
 * components to construct filter-preserving hrefs without manually joining
 * `URLSearchParams`.
 */
export function buildQs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
