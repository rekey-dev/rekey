import * as React from 'react';
import Link from '@/components/Link';

/**
 * The trail, replacing the stacked back links.
 *
 * ## What was there
 *
 * Five files carried a byte-identical `← Something` link class string, and two
 * more carried drifted variants of it. On a record page two of them rendered at
 * once, `← All applications` at the top of the application shell and
 * `← End-users` sixty pixels lower, so the page opened with two different
 * "go back" affordances pointing at two different places, neither of them
 * saying where you actually were.
 *
 * Worse, the second one was redundant: the End-users sub-tab was already
 * visible and highlighted one row above it. The link went where the tab
 * already went.
 *
 * ## Why a trail rather than a better back link
 *
 * A back link answers "how do I leave". A trail answers that AND "where am I",
 * which is the question a page four levels deep actually raises. It also
 * collapses two bands into one line, which is most of the height this
 * redesign wins back.
 *
 * The last crumb is the current page and is deliberately NOT a link, a
 * breadcrumb whose tail navigates to itself teaches people the trail is
 * decorative.
 */

export interface Crumb {
  label: React.ReactNode;
  /** Omit on the final crumb, the page you are already on. */
  href?: string;
}

export function Breadcrumb({
  items,
  className = '',
}: {
  items: Crumb[];
  className?: string;
}): React.JSX.Element {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-muted-fg)]">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden="true" className="text-[var(--color-faint-fg)]">
                  /
                </span>
              )}
              {c.href !== undefined && !last ? (
                <Link
                  href={c.href}
                  className="max-w-[16rem] truncate rounded transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className="max-w-[16rem] truncate text-[var(--color-fg)]"
                >
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
