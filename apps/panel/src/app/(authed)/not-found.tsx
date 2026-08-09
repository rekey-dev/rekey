import * as React from 'react';
import Link from 'next/link';

/**
 * 404 inside the authed console. Same reason as the sibling `forbidden.tsx`:
 * with the only not-found file at the app root, the boundary sat above this
 * layout and a single missing resource unmounted the entire console.
 *
 * This is the common case, not the rare one — `ensureAppAccess` answers 404
 * (not 403) for a member with no grant on an application, so any wrong or
 * ungranted app URL took the whole panel down.
 */
export default function AuthedNotFound(): React.JSX.Element {
  return (
    <div className="grid place-items-center px-6 py-20">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center space-y-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">404</p>
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Page not found</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">
          This page doesn&apos;t exist, may have been moved, or belongs to a workspace you
          don&apos;t have access to.
        </p>
        <Link
          href="/applications"
          className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          Back to Applications
        </Link>
      </div>
    </div>
  );
}
