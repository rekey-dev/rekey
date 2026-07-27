import * as React from 'react';
import Link from 'next/link';
import { signOutAction } from '@/lib/actions';

/**
 * Signed-in app chrome: a top bar with nav links, the current workspace +
 * plan badges, and sign-out. Server-rendered; `active` highlights the page.
 */
export function AppShell({
  active,
  email,
  workspaceLabel,
  planLabel,
  isPro,
  children,
}: {
  active: 'dashboard' | 'billing' | 'team' | 'account';
  email: string;
  workspaceLabel: string;
  planLabel: string;
  isPro: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const tabs: Array<{ key: typeof active; href: string; label: string }> = [
    { key: 'dashboard', href: '/dashboard', label: 'Dashboard' },
    { key: 'billing', href: '/billing', label: 'Billing' },
    { key: 'team', href: '/team', label: 'Team' },
    { key: 'account', href: '/account', label: 'Account' },
  ];
  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-950/70 backdrop-blur">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link href="/dashboard" className="font-bold text-rekey-700 dark:text-rekey-500">
            Rekey SaaS
          </Link>
          <span className="pill">{workspaceLabel}</span>
          <span className={`pill ${isPro ? 'pill-pro' : ''}`}>{planLabel}</span>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:inline text-sm text-neutral-500">{email}</span>
            <form action={signOutAction}>
              <button type="submit" className="btn-ghost">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav className="mx-auto max-w-4xl px-4 flex gap-1">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                t.key === active
                  ? 'border-rekey-600 text-rekey-700 dark:text-rekey-500'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 space-y-5">{children}</main>
    </div>
  );
}
