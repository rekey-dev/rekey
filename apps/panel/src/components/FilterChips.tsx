import * as React from 'react';

/**
 * Narrowing what a list shows. NOT navigation.
 *
 * ## Why this is its own idiom
 *
 * Three of these existed, in three different shapes, and none of them looked
 * like the other two:
 *
 *   devices             flat pills, `bg-surface-muted` when active
 *   email delivery      outlined, teal border AND teal text when active
 *   import preview      outlined, muted fill when active, with a count
 *
 * The devices one was the real problem: flat pills with a muted-fill active
 * state are *exactly* the treatment `AppNav`'s primary row uses. On the
 * devices tab it landed directly beneath two tab strips and a record switcher,
 * so the page ended with four horizontal rows of things-that-look-like-tabs,
 * one of which silently changed a query string instead of the route.
 *
 * A filter is a different kind of act from navigation and has to look like
 * one. Outlined-and-transparent reads as a control you toggle; solid or
 * underlined reads as a place you go. So: one component, outlined, and
 * deliberately NOT the shape of any of the three strips above it.
 *
 * ## The active state
 *
 * Teal border with the label at full foreground, over a wash of the brand at
 * 8%. The email version tinted the LABEL teal too, which put brand-coloured
 * text at 12px against the page, the smallest, least legible thing on screen
 * carrying the least legible colour. The border and the wash carry "selected"
 * on their own; the text can stay readable.
 *
 * Renders plain `<a>` rather than `next/link`, because every caller is
 * changing a search param on the page it is already on and a full navigation
 * is both correct and cheaper than a client-side transition here.
 */

export interface FilterChip {
  /** `undefined` is the "no filter" chip, conventionally first, labelled All. */
  value: string | undefined;
  label: React.ReactNode;
  /** Optional trailing count, e.g. the import preview's per-outcome totals. */
  count?: number;
}

export function FilterChips({
  chips,
  active,
  hrefFor,
  label,
  className = '',
}: {
  chips: FilterChip[];
  /** The currently applied value; `undefined` means unfiltered. */
  active: string | undefined;
  /** Build the href for a chip. Callers own how the value maps to the URL. */
  hrefFor: (value: string | undefined) => string;
  /** `aria-label` for the group. Say what is being narrowed. */
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <nav aria-label={label} className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {chips.map((c) => {
        const isActive = active === c.value || (active === undefined && c.value === undefined);
        return (
          <a
            key={c.value ?? '__all__'}
            href={hrefFor(c.value)}
            aria-current={isActive ? 'true' : undefined}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
              isActive
                ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] font-medium text-[var(--color-fg)]'
                : 'border-[var(--color-border)] text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
            }`}
          >
            {c.count !== undefined && <span className="font-semibold tabular-nums">{c.count}</span>}
            {c.label}
          </a>
        );
      })}
    </nav>
  );
}
