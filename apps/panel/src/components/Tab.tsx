'use client';

/**
 * Tab link with active-state styling. Lives in a client component because
 * it needs `usePathname()`. Server-side fallback (no JS): all tabs render
 * unhighlighted but functional.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { LinkPending } from '@/components/LinkPending';
import { usePathname } from 'next/navigation';

export function Tab({
  href,
  children,
  matchPrefix,
  exact,
}: {
  href: string;
  children: React.ReactNode;
  /** Optional override, defaults to `href`. Use when one tab matches several routes. */
  matchPrefix?: string;
  /** Active only on exact pathname match. Use for "Overview"-style parent links. */
  exact?: boolean;
}): React.JSX.Element {
  const pathname = usePathname();
  const prefix = matchPrefix ?? href;
  const active = exact
    ? pathname === prefix
    : pathname === prefix || pathname.startsWith(prefix + '/');
  // Active: teal (--color-primary) underline, full-fg text. Inactive: muted,
  // hover lifts to fg and shows a faint border.
  //
  // design.md §15 (Tabs) still describes this as "underline-on-active in
  // primary red", left over from before the red-to-teal rebrand. The token
  // has been --color-primary (teal) throughout this component; treat the doc
  // as stale, not this file.
  const base =
    'px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)] focus-visible:rounded-sm';
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

  // `aria-current` was missing entirely, while AppNav and Sidebar both set it.
  // A screen-reader user got three tab strips of which only two announced
  // which item was current, and this is the strip the nested sections used.
  return (
    <Link href={href} ref={ref} aria-current={active ? 'page' : undefined} className={cls}>
      <LinkPending>{children}</LinkPending>
    </Link>
  );
}
