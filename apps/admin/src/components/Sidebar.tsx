'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';

interface NavItem {
  href: string;
  label: string;
  icon: React.JSX.Element;
}

const ICONS = {
  overview: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  tenants: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  ),
  applications: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  users: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  billing: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  ),
  webhooks: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M14 5a3 3 0 1 1 4 4l-5 8" />
      <path d="M9 18l5-8" />
    </svg>
  ),
  services: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  audit: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  requests: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  invites: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16v16H4z" />
      <path d="M22 6l-10 7L2 6" />
    </svg>
  ),
  signout: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
};

const NAV: NavItem[] = [
  { href: '/', label: 'Overview', icon: ICONS.overview },
  { href: '/tenants', label: 'Tenants', icon: ICONS.tenants },
  { href: '/applications', label: 'Applications', icon: ICONS.applications },
  { href: '/users', label: 'End-users', icon: ICONS.users },
  { href: '/operator-invites', label: 'Operator invites', icon: ICONS.invites },
  { href: '/billing', label: 'Billing', icon: ICONS.billing },
  { href: '/webhooks', label: 'Webhooks', icon: ICONS.webhooks },
  { href: '/services', label: 'Services', icon: ICONS.services },
  { href: '/audit', label: 'Audit log', icon: ICONS.audit },
  { href: '/requests', label: 'Requests', icon: ICONS.requests },
];

export function Sidebar(): React.JSX.Element {
  const pathname = usePathname();
  // Mobile drawer state. The sidebar is a static column at md+ and a slide-in
  // overlay below it (toggled by the hamburger). Closing on every pathname
  // change means a nav tap dismisses the drawer without per-link handlers.
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <>
      {/* Hamburger — only below md, where the drawer is collapsed. Sits above
          page content but below the open drawer (which is z-40). */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="fixed left-3 top-3 z-30 inline-grid h-9 w-9 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 md:hidden"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* Backdrop — only present while the mobile drawer is open. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={
          'fixed inset-y-0 left-0 z-40 w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col h-screen transform transition-transform duration-200 md:sticky md:top-0 md:translate-x-0 ' +
          (open ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
        }
      >
        <div className="flex items-start justify-between px-4 pt-4 pb-3">
          <div>
            <Link href="/" className="mb-2 inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-mark.png" alt="" className="h-6 w-auto" />
              <span className="text-sm font-semibold text-[var(--color-fg)]">ReliPay</span>
            </Link>
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">Super Admin</p>
          </div>
          {/* Close affordance — mobile only; md+ has no drawer to close. */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="-mr-1 inline-grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 md:hidden"
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {NAV.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 ' +
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
      </nav>

      <div className="border-t border-[var(--color-border)] px-3 py-3 min-w-0 space-y-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">Read-only</p>
        <div className="flex items-center gap-2">
          {/* POST form, not an <a href>, so the sign-out is CSRF-safe — a
              cross-site image/link can't auto-submit a form via GET, and the
              route now returns 405 on GET (see app/sign-out/route.ts). */}
          <form action="/sign-out" method="post">
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
            >
              {ICONS.signout}
              Sign out
            </button>
          </form>
          <ThemeToggle />
        </div>
      </div>
      </aside>
    </>
  );
}
