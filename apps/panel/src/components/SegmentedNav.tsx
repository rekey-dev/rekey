'use client';

/**
 * The THIRD level of navigation, when a page already has two.
 *
 * ## The problem this exists to solve
 *
 * `AppNav` renders two strips: a pill row of groups and an underline row of
 * that group's children. Anything nested below one of those children, an
 * end-user, the email section, a webhook endpoint, used to add a third
 * full-width underline strip of its own, plus a back link, plus a second
 * identity header. The end-user page reached six horizontal bands of chrome
 * before a single fact about the user appeared, and two of those bands were
 * near-identical underline strips stacked directly on each other. Nothing in
 * the shape told you which one governed which.
 *
 * Adding a third strip in the same idiom is the failure. Two strips of the
 * same kind read as a hierarchy; three read as a wall, because the eye has no
 * way to rank them.
 *
 * ## The rule
 *
 * **A page shows at most two tab strips. A third level changes idiom.**
 *
 * So this is a segmented control: enclosed in a track, sitting INSIDE the
 * record's own header rather than spanning the page. Enclosure is the whole
 * point, it says "these switch what you see about THIS record", where the
 * strips above span the page and say "these switch where you are in the
 * application". Same tokens, same type scale, different shape language.
 *
 * ## Why the active segment is a raised surface and not a teal fill
 *
 * The underline strip above it already spends the brand colour. A teal fill
 * here would compete with its parent for attention, which inverts the
 * hierarchy, the deepest control would shout loudest. A raised surface reads
 * as selected without adding a third accent, and it survives both themes:
 * light lifts (#f3ede7 track, #ffffff thumb) and dark recesses (#1c1c1c track,
 * #111111 thumb). The ring carries the edge in both directions, which is why
 * it is not decoration.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { LinkPending } from '@/components/LinkPending';
import { usePathname } from 'next/navigation';

export interface Segment {
  href: string;
  label: React.ReactNode;
  /** Active only on an exact pathname match. Use for the record's landing tab. */
  exact?: boolean;
  /** Match this prefix instead of `href`, for a tab covering several routes. */
  matchPrefix?: string;
}

export function SegmentedNav({
  segments,
  label,
  fallbackHref,
  className = '',
}: {
  segments: Segment[];
  /** `aria-label` for the nav. Say what is being switched, e.g. "End-user sections". */
  label: string;
  /**
   * Which segment owns routes that match none of them.
   *
   * The email section had this exact hole: `email/[eventKey]` is a child of
   * Templates but lives at a sibling path, so the strip rendered on that route
   * with NOTHING highlighted, four segments all reading as "not here", which
   * looks like a bug and tells the operator nothing about where they are. A
   * dynamic child cannot be enumerated as a prefix, so the parent claims the
   * leftovers instead.
   */
  fallbackHref?: string;
  className?: string;
}): React.JSX.Element {
  const pathname = usePathname() ?? '';

  const matches = (s: Segment): boolean => {
    const prefix = s.matchPrefix ?? s.href;
    return s.exact === true
      ? pathname === prefix
      : pathname === prefix || pathname.startsWith(prefix + '/');
  };

  const anyMatched = segments.some(matches);
  const isActive = (s: Segment): boolean =>
    anyMatched ? matches(s) : fallbackHref !== undefined && s.href === fallbackHref;

  // Deep-linking into a segment that has scrolled out of the track leaves the
  // control looking as though nothing is selected. Same one-shot fix the two
  // AppNav rows use, scoped to this track so it cannot scroll the page.
  const trackRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    trackRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <nav
      ref={trackRef}
      aria-label={label}
      className={`inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1 ${className}`}
    >
      {segments.map((s) => {
        const active = isActive(s);
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
              active
                ? 'bg-[var(--color-surface)] font-medium text-[var(--color-fg)] shadow-sm ring-1 ring-[var(--color-border)]'
                : 'text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]'
            }`}
          >
            <LinkPending>{s.label}</LinkPending>
          </Link>
        );
      })}
    </nav>
  );
}
