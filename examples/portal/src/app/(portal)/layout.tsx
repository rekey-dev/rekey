/**
 * Signed-in shell — top bar with the application name, nav, and the
 * signed-in email. Every page under this group requires a session.
 */

import type { ReactNode } from 'react';
import { requireSession, getAppName } from '@/lib/session';
import { signOutAction } from '@/lib/actions';
import { NavLink } from '@/components/nav-link';

export default async function PortalLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  const session = await requireSession();
  const appName = await getAppName();

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold">{appName}</span>
            <nav className="flex items-center gap-1">
              <NavLink href="/subscription">Subscription</NavLink>
              <NavLink href="/billing">Billing history</NavLink>
              <NavLink href="/plans">Plans</NavLink>
              <NavLink href="/account">Account</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-[var(--color-muted-fg)] sm:inline">
              {session.user.email}
            </span>
            <form action={signOutAction}>
              <button
                type="submit"
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-8">{children}</main>
    </div>
  );
}
