import * as React from 'react';
import Link from 'next/link';

/** Root 404 (WP15) — friendly, token-styled, links back to safety. */
export default function NotFound(): React.JSX.Element {
  return (
    <main className="min-h-screen grid place-items-center px-6 bg-[var(--color-bg)]">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center space-y-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">404</p>
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Page not found</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">
          The page you&apos;re looking for doesn&apos;t exist or may have been moved.
        </p>
        <Link
          href="/applications"
          className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"
        >
          Back to Applications
        </Link>
      </div>
    </main>
  );
}
