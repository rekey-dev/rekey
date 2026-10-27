'use client';

/**
 * Global sidebar for the operator panel: brand and version, workspace
 * switcher and search up top, global nav links, then workspace settings and
 * the account menu at the bottom. Per-app
 * navigation is rendered as a *secondary* sidebar inside the app layout
 * (apps/[id]/layout.tsx), not here, so the global sidebar stays predictable
 * across every page.
 *
 * Active link styling uses next/navigation's pathname. Anything starting
 * with the link's `href` highlights, works for nested routes like
 * `/applications/<id>/...` matching the "Applications" link.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { LinkPending } from '@/components/LinkPending';
import { usePathname } from 'next/navigation';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { ThemeToggle } from './ThemeToggle';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';
import { openCommandPalette } from './CommandPalette';
import { AnalyticsEvent, track } from '@/lib/analytics';

interface Membership {
  tenantId: string;
  tenantName: string;
  role: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.JSX.Element;
  /**
   * Hide this item below this role.
   *
   * The nav used to list every destination to everyone, which was survivable
   * only because the pages behind them happened to be readable by everyone.
   * Once the workspace audit surfaces were lowered to an ADMIN floor, a MEMBER
   * was left with links that navigate to a 403, the worst version of a
   * permission error, because the product itself suggested the click.
   *
   * Gating the nav is presentation, not enforcement: the API is the only thing
   * that decides, and it still refuses these routes for a MEMBER who types the
   * URL. This just stops us advertising a door that is locked.
   */
  minRole?: 'ADMIN';
}

/** OWNER outranks ADMIN outranks MEMBER; anything unrecognised is treated as lowest. */
function meetsRole(activeRole: string, minRole: NavItem['minRole']): boolean {
  if (!minRole) return true;
  return activeRole === 'OWNER' || activeRole === 'ADMIN';
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
  signout: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  discord: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.1.246.198.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  ),
  settings: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  chevrons: (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
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
      className="flex w-full items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-muted-fg)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
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
  /** Omitted for the first group, which needs no label. */
  heading?: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    items: [
      { href: '/applications', label: 'Applications', icon: ICONS.apps },
      { href: '/team', label: 'Team', icon: ICONS.team },
    ],
  },
  {
    heading: 'Logs',
    items: [
      { href: '/audit-log', label: 'Audit log', icon: ICONS.audit, minRole: 'ADMIN' },
      { href: '/email-logs', label: 'Email delivery', icon: ICONS.mail, minRole: 'ADMIN' },
    ],
  },
];

const SETTINGS: NavItem = { href: '/workspace', label: 'Workspace settings', icon: ICONS.settings };

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

function NavLink({ item, active }: { item: NavItem; active: boolean }): React.JSX.Element {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={
        `flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors ${FOCUS_RING} ` +
        (active
          ? 'bg-[var(--color-surface-muted)] font-medium text-[var(--color-primary)]'
          : 'text-[var(--color-muted-fg)] hover:bg-[color-mix(in_srgb,var(--color-surface-muted)_60%,transparent)] hover:text-[var(--color-fg)]')
      }
    >
      <span className={active ? 'text-[var(--color-primary)]' : 'text-[var(--color-faint-fg)]'}>{item.icon}</span>
      <LinkPending>{item.label}</LinkPending>
    </Link>
  );
}

/**
 * The signed-in operator at the foot of the sidebar, opening upward into
 * their Account pages, the theme and sign-out.
 */
function AccountMenu({
  userEmail,
  signOutAction,
  active,
}: {
  userEmail: string;
  signOutAction: () => Promise<void>;
  /** On a page this menu leads to, so the sidebar still shows where you are. */
  active: boolean;
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <button
          type="button"
          title={userEmail}
          className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-surface-muted)] ${active ? 'bg-[var(--color-surface-muted)]' : ''} ${FOCUS_RING}`}
        >
          <span
            aria-hidden="true"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-surface-muted)] text-xs font-semibold text-[var(--color-fg)]"
          >
            {userEmail.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted-fg)]">{userEmail}</span>
          <span className="text-[var(--color-faint-fg)]">{ICONS.chevrons}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent sideOffset={0} className="bottom-full mb-1 w-full">
        <p className="truncate px-2 py-1.5 text-sm font-medium text-[var(--color-fg)]" title={userEmail}>
          {userEmail}
        </p>
        <DropdownMenuSeparator />
        <DropdownMenuItem href="/account">
          <span className="flex items-center gap-2">
            <span className="text-[var(--color-faint-fg)]">{ICONS.security}</span>
            Account
          </span>
        </DropdownMenuItem>
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-sm text-[var(--color-fg)]">Theme</span>
          <ThemeToggle />
        </div>
        <DropdownMenuSeparator />
        {/* A plain form, not a DropdownMenuItem: closing the menu on click
            would unmount the button before the browser submits its form. */}
        <ActionForm action={signOutAction}>
          <SubmitButton
            pendingLabel="Signing out…"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
          >
            <span className="text-[var(--color-faint-fg)]">{ICONS.signout}</span>
            Sign out
          </SubmitButton>
        </ActionForm>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar({
  memberships,
  activeTenantId,
  activeRole,
  userEmail,
  switchAction,
  createWorkspaceAction,
  signOutAction,
  buildVersion,
  discordUrl,
}: {
  memberships: Membership[];
  activeTenantId: string;
  activeRole: string;
  userEmail: string;
  switchAction: (formData: FormData) => Promise<void>;
  /** Omitted when this deployment does not allow additional workspaces. */
  createWorkspaceAction?: ((formData: FormData) => Promise<void>) | undefined;
  signOutAction: () => Promise<void>;
  /** The version badge beside the logo, rendered by the server (`BuildVersion`). */
  buildVersion?: React.ReactNode;
  /** Set on Rekey Cloud only. Unset hides the "Get help on Discord" row. */
  discordUrl?: string | undefined;
}): React.JSX.Element {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <aside className="w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col h-dvh sticky top-0">
      <div className="px-3 pt-4 pb-2 space-y-3">
        <div className="flex items-center gap-2 px-2">
          <Link href="/applications" className={`inline-flex items-center gap-2 rounded-md ${FOCUS_RING}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.png" alt="" className="h-6 w-6" />
            <span className="text-[15px] font-semibold tracking-tight text-[var(--color-fg)]">Rekey</span>
          </Link>
          {buildVersion}
        </div>
        <WorkspaceSwitcher
          memberships={memberships}
          activeTenantId={activeTenantId}
          switchAction={switchAction}
          {...(createWorkspaceAction && { createAction: createWorkspaceAction })}
        />
        <SearchButton />
      </div>

      <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
        {NAV.filter((section) =>
          // A heading with nothing under it reads as a broken nav rather than a
          // permission boundary.
          section.items.some((item) => meetsRole(activeRole, item.minRole)),
        ).map((section) => (
          <div key={section.heading ?? 'main'} className="space-y-0.5">
            {section.heading && (
              <p className="px-2 pb-1 text-xs font-medium text-[var(--color-muted-fg)]">{section.heading}</p>
            )}
            {section.items
              .filter((item) => meetsRole(activeRole, item.minRole))
              .map((item) => (
                <NavLink key={item.href} item={item} active={isActive(item.href)} />
              ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--color-border)] px-3 py-2 min-w-0 space-y-1">
        <NavLink item={SETTINGS} active={isActive(SETTINGS.href)} />
        {discordUrl && (
          <a
            href={discordUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track(AnalyticsEvent.DiscordClicked)}
            title="Priority support on Discord for paying customers"
            className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--color-muted-fg)] hover:bg-[color-mix(in_srgb,var(--color-surface-muted)_60%,transparent)] hover:text-[var(--color-fg)] ${FOCUS_RING}`}
          >
            <span className="text-[var(--color-faint-fg)]">{ICONS.discord}</span>
            Get help on Discord
          </a>
        )}
        <AccountMenu userEmail={userEmail} signOutAction={signOutAction} active={isActive('/account')} />
      </div>
    </aside>
  );
}
