'use client';

/**
 * Tab link with active-state styling. Lives in a client component because
 * it needs `usePathname()`. Server-side fallback (no JS): all tabs render
 * unhighlighted but functional.
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Tab({
  href,
  children,
  matchPrefix,
  exact,
}: {
  href: string;
  children: React.ReactNode;
  /** Optional override — defaults to `href`. Use when one tab matches several routes. */
  matchPrefix?: string;
  /** Active only on exact pathname match. Use for "Overview"-style parent links. */
  exact?: boolean;
}): React.JSX.Element {
  const pathname = usePathname();
  const prefix = matchPrefix ?? href;
  const active = exact
    ? pathname === prefix
    : pathname === prefix || pathname.startsWith(prefix + '/');
  // Active: red underline, full-fg text. Inactive: muted, hover lifts to fg
  // and shows a faint border. See design.md §13.
  const base =
    'px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 focus-visible:rounded-sm';
  const cls = active
    ? `${base} text-[var(--color-fg)] border-[var(--color-primary)] font-medium`
    : `${base} text-[var(--color-muted-fg)] border-transparent hover:text-[var(--color-fg)] hover:border-[var(--color-border)]`;

  // Scroll the active tab into view when the user deep-links into a tab.
  // The wrapping <nav> uses overflow-x-auto; the right-edge mask added in
  // layout.tsx hides the cut-off, but the active tab can still be off-
  // screen on narrow viewports. scrollIntoView fixes that one-shot.
  const ref = React.useRef<HTMLAnchorElement>(null);
  React.useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [active]);

  return (
    <Link href={href} ref={ref} className={cls}>
      {children}
    </Link>
  );
}
