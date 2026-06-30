'use client';

/**
 * Two-level application nav.
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │  Overview  Users  Authentication  [Billing]  Developer │  ← primary group pills
 *   ├───────────────────────────────────────────────────────┤
 *   │  Methods   OAuth   MCP                                  │  ← sub-tabs of the active group
 *   └───────────────────────────────────────────────────────┘
 *
 * The active group is derived from the current path's first segment under
 * `/applications/{id}`. Clicking a group jumps to its first sub-tab; clicking
 * the already-active group is a no-op (links to the current path). Groups with
 * a single sub-tab (Overview, Users) render no second row — the primary row
 * carries the bottom border instead.
 *
 * The Billing group is omitted entirely when the application has billing
 * disabled — matching the server-side gate (`requireBillingEnabled`).
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface SubTab {
  /** Path segment under `/applications/{id}`. Empty string = the group landing. */
  seg: string;
  label: string;
}

interface Group {
  key: string;
  label: string;
  children: SubTab[];
}

export function AppNav({
  id,
  billingEnabled,
}: {
  id: string;
  billingEnabled: boolean;
}): React.JSX.Element {
  const pathname = usePathname() ?? '';
  const base = `/applications/${id}`;
  const suffix = pathname.startsWith(base) ? pathname.slice(base.length) : '';
  const currentSeg = suffix.replace(/^\//, '').split('/')[0] ?? '';

  const groups: Group[] = [
    { key: 'overview', label: 'Overview', children: [{ seg: '', label: 'Overview' }] },
    {
      key: 'users',
      label: 'Users',
      children: [
        { seg: 'end-users', label: 'End-users' },
        { seg: 'organizations', label: 'Organizations' },
        { seg: 'activity', label: 'Activity' },
      ],
    },
    {
      key: 'auth',
      label: 'Authentication',
      children: [
        { seg: 'auth', label: 'Methods' },
        { seg: 'oauth', label: 'OAuth' },
        { seg: 'mcp', label: 'MCP' },
      ],
    },
    ...(billingEnabled
      ? [
          {
            key: 'billing',
            label: 'Billing',
            children: [
              // Revenue dashboard is the group landing — stat tiles + the
              // 12-month revenue chart live at /applications/{id}/revenue.
              { seg: 'revenue', label: 'Overview' },
              { seg: 'billing', label: 'Providers' },
              { seg: 'plans', label: 'Plans' },
              { seg: 'payments', label: 'Payments' },
              { seg: 'dunning', label: 'Dunning' },
              { seg: 'coupons', label: 'Coupons' },
              { seg: 'licenses', label: 'Licenses' },
              { seg: 'usage', label: 'Usage' },
              { seg: 'portal', label: 'Portal' },
            ],
          },
        ]
      : []),
    {
      key: 'developer',
      label: 'Developer',
      children: [
        { seg: 'api-keys', label: 'API keys' },
        { seg: 'webhooks', label: 'Webhooks' },
        { seg: 'requests', label: 'Requests' },
        { seg: 'access', label: 'Access' },
        { seg: 'email', label: 'Email' },
      ],
    },
  ];

  const hrefFor = (seg: string): string => (seg === '' ? base : `${base}/${seg}`);

  // WP16: the sub-tab row scrolls horizontally on narrow screens — make sure
  // the active tab is visible on mount / navigation. No smooth scrolling on
  // first paint (it would animate on every page load).
  const subRowRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const active = subRowRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentSeg]);

  const activeGroup =
    groups.find((g) => g.children.some((c) => c.seg === currentSeg)) ?? groups[0]!;
  const hasSubRow = activeGroup.children.length > 1;

  return (
    <div className="-mx-6">
      {/* Primary group row */}
      <nav
        className={`flex items-center gap-1 px-6 ${
          hasSubRow ? '' : 'border-b border-[var(--color-border)]'
        }`}
      >
        {groups.map((g) => {
          const isActive = g.key === activeGroup.key;
          const target = isActive ? pathname : hrefFor(g.children[0]!.seg);
          return (
            <Link
              key={g.key}
              href={target}
              aria-current={isActive ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 ${
                isActive
                  ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                  : 'text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]/60'
              }`}
            >
              {g.label}
            </Link>
          );
        })}
      </nav>

      {/* Secondary sub-tab row — only for groups with more than one sub-tab. */}
      {hasSubRow && (
        <div className="relative">
          <nav
            ref={subRowRef}
            className="flex items-center gap-1 border-b border-[var(--color-border)] overflow-x-auto px-6"
          >
            {activeGroup.children.map((c) => {
              const isActive = c.seg === currentSeg;
              return (
                <Link
                  key={c.seg || 'index'}
                  href={hrefFor(c.seg)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`-mb-px whitespace-nowrap rounded-t border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 ${
                    isActive
                      ? 'border-[var(--color-primary)] text-[var(--color-fg)] font-medium'
                      : 'border-transparent text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {c.label}
                </Link>
              );
            })}
          </nav>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 right-0 h-full w-12 bg-gradient-to-l from-[var(--color-bg)] via-[var(--color-bg)]/80 to-transparent"
          />
        </div>
      )}
    </div>
  );
}
