'use client';

/**
 * Segment-level error boundary for all authed routes (WP15). Catches
 * render/data errors below the (authed) layout so the sidebar stays up
 * and the operator gets a retry instead of a white screen.
 */

import * as React from 'react';

export default function AuthedError({
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
    <section className="mx-auto max-w-5xl px-6 py-6">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center space-y-3">
        <p className="text-sm font-medium text-[var(--color-fg)]">Something went wrong loading this page</p>
        <p className="mx-auto max-w-md text-xs text-[var(--color-muted-fg)]">
          The request failed or the page hit an unexpected error. Retrying usually fixes transient
          problems; if it keeps happening, note what you were doing and contact support.
          {error.digest ? ` (ref ${error.digest})` : ''}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          Try again
        </button>
      </div>
    </section>
  );
}
