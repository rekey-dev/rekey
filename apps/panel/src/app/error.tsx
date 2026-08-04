'use client';

/**
 * Root error boundary for the panel's UNAUTHED routes.
 *
 * `(authed)/error.tsx` has covered the signed-in surface since WP15, but it is
 * scoped to that route group — nothing below `/login`, `/sign-up`,
 * `/accept-invite`, `/magic-link`, `/mfa-verify`, `/forgot-password`,
 * `/reset-password` or `/mcp-consent` had a boundary at all. Those routes are
 * not quiet: every one of them talks to the API through `publicGet`/`publicPost`,
 * which throw a `PanelApiError` on any non-2xx.
 *
 * `/mcp-consent/review` is the one that hurts. It resolves the OAuth request
 * mid-consent; an API hiccup there dropped the operator onto Next's default
 * error page in the middle of an authorization flow started by an external MCP
 * client, with no way back into the flow and no indication of what to do.
 *
 * Kept separate from `(authed)/error.tsx` rather than merged: this one cannot
 * offer "Back to applications" (the visitor may not be signed in) and must not
 * assume the panel chrome exists around it.
 */

import * as React from 'react';
import Link from 'next/link';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    // Surface in the browser console for debugging; no client error sink yet.
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-[var(--color-bg)]">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center space-y-3">
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Something went wrong</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">
          This page failed to load. Retrying usually fixes transient problems; if it keeps
          happening, note what you were doing and contact support.
          {error.digest ? ` (ref ${error.digest})` : ''}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
          >
            Try again
          </button>
          <Link
            href="/login"
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
