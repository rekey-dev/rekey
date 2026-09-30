'use client';

/**
 * Two-level application nav.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Overview  Users  Audience  Authentication  [Billing]  Developer  │  ← primary group pills
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │  Methods   Sign-in providers   OAuth clients   MCP               │  ← sub-tabs of the active group
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The active group is derived from the current path's first segment under
 * `/applications/{id}`. Clicking a group jumps to its first sub-tab; clicking
 * the already-active group is a no-op (links to the current path). Groups with
 * a single sub-tab (Overview, Audience) render no second row, the primary row
 * carries the bottom border instead.
 *
 * When the application has billing disabled the Billing group keeps its FULL
 * child list but retargets the group pill at the Setup page, the only
 * place billing can be turned back on. Only the link target changes; the
 * children stay, which is what makes `/plans`, `/payments`, `/coupons` &c.
 * still resolve to the Billing group while billing is off.
 *
 * That last point is load-bearing. When the group held only `{seg:'billing'}`,
 * a path like `/applications/{id}/plans` matched NO group, so the `?? groups[0]`
 * fallback marked *Overview* active, while `target = pathname` pointed that
 * "Overview" tab back at /plans. The result was a tab that claimed
 * `aria-current="page"`, linked to the page you were already on, rendered no
 * sub-tab row, and left no way back. It is one click from the default landing
 * page: the app Overview's Configuration list and the get-started checklist
 * both link into billing children while billing is off.
 *
 * The groups themselves are defined in `lib/app-sections.ts`, shared with the
 * command palette.
 *
 * Both rows scroll horizontally. `main` is `overflow-x: hidden`, so a primary
 * row wider than the viewport (457px of pills at a 375px viewport) is not
 * merely clipped, the whole Developer group becomes unreachable on a phone.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { LinkPending } from '@/components/LinkPending';
import { usePathname } from 'next/navigation';
import { hasScope } from '@/lib/operator-scopes';
import { APP_SECTION_GROUPS, BILLING_GATED_SEGS, SEG_SCOPE, type AppSection } from '@/lib/app-sections';

interface Group {
  key: string;
  label: React.ReactNode;
  children: AppSection[];
  /**
   * Segment the group PILL links to, when it isn't the first child. Used by
   * Billing-while-disabled: every child stays in the list (so paths still
   * resolve to this group) but the pill points at Setup, the one page
   * that isn't server-gated.
   */
  entrySeg?: string;
  /** Sub-tabs to hide from the second row without removing them from matching. */
  hiddenSegs?: readonly string[];
}

export function AppNav({
  id,
  billingEnabled,
  scopes = null,
  usersOverview = true,
}: {
  id: string;
  billingEnabled: boolean;
  /** The caller's effective scopes on this Application; null = unrestricted. */
  scopes?: string[] | null;
  /** False when the API predates the Users overview, so the tab is not offered. */
  usersOverview?: boolean;
}): React.JSX.Element {
  const visible = (seg: string): boolean => {
    if (seg === 'users' && !usersOverview) return false;
    const need = SEG_SCOPE[seg];
    return need === null || need === undefined || hasScope(scopes, need);
  };
  const pathname = usePathname() ?? '';
  const base = `/applications/${id}`;
  const suffix = pathname.startsWith(base) ? pathname.slice(base.length) : '';
  const currentSeg = suffix.replace(/^\//, '').split('/')[0] ?? '';

  const billingLabel = billingEnabled ? (
    'Billing'
  ) : (
    <span className="inline-flex items-center gap-1.5">
      Billing
      <span className="rounded bg-[var(--color-surface-muted)] px-1 py-px text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">
        off
      </span>
    </span>
  );
  // The billing child list is IDENTICAL in both states, see the note at the
  // top of the file. Only `entrySeg` and `hiddenSegs` differ, so a billing
  // child path always resolves to this group and always gets a way back.
  const groups: Group[] = APP_SECTION_GROUPS.map((g) =>
    g.key === 'billing'
      ? {
          key: g.key,
          label: billingLabel,
          children: g.sections,
          ...(billingEnabled ? {} : { entrySeg: 'billing', hiddenSegs: BILLING_GATED_SEGS }),
        }
      : { key: g.key, label: g.label, children: g.sections },
  );

  const hrefFor = (seg: string): string => (seg === '' ? base : `${base}/${seg}`);

  // BOTH rows scroll horizontally on narrow screens, make sure the
  // active item is visible on mount / navigation. No smooth scrolling on
  // first paint (it would animate on every page load).
  //
  // `inline: 'nearest'` scrolls the nearest scroll container only; without the
  // guard below it would also scroll the *page* horizontally on some engines,
  // which is why each row is scrolled independently rather than via a single
  // document-wide query.
  const primaryRowRef = React.useRef<HTMLElement | null>(null);
  const subRowRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    for (const row of [primaryRowRef.current, subRowRef.current]) {
      const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
      active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [currentSeg]);

  // Sections the caller cannot read are not offered. A group with nothing
  // left is not offered either. The active-group lookup runs on the full
  // list so a URL the caller typed still resolves to the right group.
  const scoped = groups
    .map((g) => ({ ...g, children: g.children.filter((c) => visible(c.seg)) }))
    .filter((g) => g.children.length > 0);
  const activeGroup =
    scoped.find((g) => g.children.some((c) => c.seg === currentSeg)) ??
    groups.find((g) => g.children.some((c) => c.seg === currentSeg)) ??
    scoped[0] ??
    groups[0]!;
  const hidden = new Set<string>(activeGroup.hiddenSegs ?? []);
  // Keep a hidden child visible while you are standing on it, otherwise the row
  // would render without the current page in it.
  const visibleChildren = activeGroup.children.filter(
    (c) => !hidden.has(c.seg) || c.seg === currentSeg,
  );
  const hasSubRow = visibleChildren.length > 1;

  return (
    <div className="-mx-6">
      {/* Primary group row, scrolls horizontally; `main` clips overflow, so
          without `overflow-x-auto` the trailing groups are unreachable below
          ~460px rather than merely off-screen. */}
      <div className="relative">
        <nav
          ref={primaryRowRef}
          className={`flex items-center gap-1 overflow-x-auto px-6 ${
            hasSubRow ? '' : 'border-b border-[var(--color-border)]'
          }`}
        >
          {scoped.map((g) => {
            const isActive = g.key === activeGroup.key;
            // The pill for the active group links to the current path (a
            // deliberate no-op). For any other group it links to `entrySeg`
            // when the group declares one, else its first child.
            const target = isActive
              ? pathname
              : hrefFor(g.entrySeg ?? g.children[0]!.seg);
            return (
              <Link
                key={g.key}
                href={target}
                aria-current={isActive ? 'page' : undefined}
                className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                  isActive
                    ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                    : 'text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:bg-[color-mix(in_srgb,var(--color-surface-muted)_60%,transparent)]'
                }`}
              >
                <LinkPending>{g.label}</LinkPending>
              </Link>
            );
          })}
        </nav>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 h-full w-12 bg-gradient-to-l from-[var(--color-bg)] via-[color-mix(in_srgb,var(--color-bg)_80%,transparent)] to-transparent"
        />
      </div>

      {/* Secondary sub-tab row, only for groups with more than one sub-tab. */}
      {hasSubRow && (
        <div className="relative">
          <nav
            ref={subRowRef}
            className="flex items-center gap-1 border-b border-[var(--color-border)] overflow-x-auto px-6"
          >
            {visibleChildren.map((c) => {
              const isActive = c.seg === currentSeg;
              return (
                <Link
                  key={c.seg || 'index'}
                  href={hrefFor(c.seg)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`-mb-px shrink-0 whitespace-nowrap rounded-t border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)] ${
                    isActive
                      ? 'border-[var(--color-primary)] text-[var(--color-fg)] font-medium'
                      : 'border-transparent text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  <LinkPending>{c.label}</LinkPending>
                </Link>
              );
            })}
          </nav>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 right-0 h-full w-12 bg-gradient-to-l from-[var(--color-bg)] via-[color-mix(in_srgb,var(--color-bg)_80%,transparent)] to-transparent"
          />
        </div>
      )}
    </div>
  );
}
