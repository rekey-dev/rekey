'use client';

/**
 * Global sidebar for the operator panel — workspace switcher up top, global
 * nav links, then the user account + sign-out at the bottom. Per-app
 * navigation is rendered as a *secondary* sidebar inside the app layout
 * (apps/[id]/layout.tsx), not here, so the global sidebar stays predictable
 * across every page.
 *
 * Active link styling uses next/navigation's pathname. Anything starting
 * with the link's `href` highlights — works for nested routes like
 * `/applications/<id>/...` matching the "Applications" link.
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { SubmitButton } from './SubmitButton';
import { openCommandPalette } from './CommandPalette';

interface Membership {
  tenantId: string;
  tenantName: string;
  role: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.JSX.Element;
  /** Optional hover tooltip — for items whose label needs a one-line gloss. */
  title?: string;
}

const ICONS = {
  apps: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  team: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  workspace: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  ),
  security: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  audit: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  ),
  mail: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  ),
  activity: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  apiKey: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  ),
  signout: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  search: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
};

/**
 * Faux-input button that opens the command palette. The shortcut hint
 * defaults to ⌘K and corrects itself to Ctrl K after mount on non-Apple
 * platforms (effect-driven, so no hydration mismatch).
 */
function SearchButton(): React.JSX.Element {
  const [isMac, setIsMac] = React.useState(true);
  React.useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/.test(navigator.platform));
  }, []);
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="mt-2 flex w-full items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-muted-fg)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
    >
      <span className="text-[var(--color-faint-fg)]">{ICONS.search}</span>
      Search…
      <kbd className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-faint-fg)]">
        {isMac ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    heading: 'Workspace',
    items: [
      { href: '/applications', label: 'Applications', icon: ICONS.apps },
      { href: '/team', label: 'Team', icon: ICONS.team },
      { href: '/workspace', label: 'Workspace settings', icon: ICONS.workspace },
    ],
  },
  {
    // Everything log/history-shaped, grouped together.
    heading: 'Logs',
    items: [
      { href: '/audit-log', label: 'Audit log', icon: ICONS.audit },
      { href: '/email-logs', label: 'Email logs', icon: ICONS.mail },
      { href: '/account/activity', label: 'My requests', icon: ICONS.activity },
    ],
  },
  {
    heading: 'Account',
    items: [
      { href: '/account/security', label: 'Account security', icon: ICONS.security },
      { href: '/account/api-tokens', label: 'API tokens', icon: ICONS.apiKey },
      {
        href: '/account/mcp',
        label: 'Operator MCP',
        icon: ICONS.apiKey,
        title: 'MCP (Model Context Protocol) — let AI agents read your workspace.',
      },
    ],
  },
];

export function Sidebar({
  memberships,
  activeTenantId,
  activeRole,
  userEmail,
  switchAction,
  createWorkspaceAction,
  signOutAction,
}: {
  memberships: Membership[];
  activeTenantId: string;
  activeRole: string;
  userEmail: string;
  switchAction: (formData: FormData) => Promise<void>;
  createWorkspaceAction: (formData: FormData) => Promise<void>;
  signOutAction: () => Promise<void>;
}): React.JSX.Element {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col h-screen sticky top-0">
      <div className="px-4 pt-4 pb-3">
        <Link
          href="/applications"
          className="mb-3 inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="h-6 w-auto" />
          <span className="text-sm font-semibold text-[var(--color-fg)]">Rekey</span>
        </Link>
        <WorkspaceSwitcher
          memberships={memberships}
          activeTenantId={activeTenantId}
          switchAction={switchAction}
          createAction={createWorkspaceAction}
        />
        <p className="mt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">
          {activeRole}
        </p>
        <SearchButton />
      </div>

      <nav className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {NAV.map((section) => (
          <div key={section.heading} className="space-y-0.5">
            <p className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">
              {section.heading}
            </p>
            {section.items.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.title}
                  aria-current={active ? 'page' : undefined}
                  className={
                    'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] ' +
                    (active
                      ? 'bg-[var(--color-surface-muted)] font-medium text-[var(--color-fg)]'
                      : 'text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]')
                  }
                >
                  <span className={active ? 'text-[var(--color-primary)]' : 'text-[var(--color-faint-fg)]'}>
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--color-border)] px-3 py-3 min-w-0 space-y-2">
        <div title={userEmail} className="text-xs text-[var(--color-muted-fg)] truncate">{userEmail}</div>
        <div className="flex items-center gap-2">
          <form action={signOutAction}>
            <SubmitButton
              pendingLabel="Signing out…"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
            >
              {ICONS.signout}
              Sign out
            </SubmitButton>
          </form>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
