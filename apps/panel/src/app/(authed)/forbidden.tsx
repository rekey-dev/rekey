import * as React from 'react';
import Link from 'next/link';

/**
 * 403 inside the authed console.
 *
 * The root `forbidden.tsx` alone was not enough. Next puts the
 * HTTPAccessFallbackBoundary at the segment that owns the file, so with the
 * only one at the app root the boundary sat ABOVE this layout: a single 403 on
 * a single fetch unmounted the sidebar, the workspace switcher and the command
 * palette, and replaced the console with a full-screen card whose one exit was
 * a hard link back to /applications. `lib/api.ts` claimed the opposite — that
 * the boundary "keeps the chrome and offers a way back" — and it did not.
 *
 * That mattered most for a mistyped or ungranted application id, which answers
 * 404 for a member with no grant, so any wrong app URL blanked the whole
 * console rather than one panel.
 *
 * This file exists so the boundary lands INSIDE the layout instead. Same
 * message, no `min-h-screen`, so it fills the content area and leaves the
 * navigation where it was.
 */
export default function AuthedForbidden(): React.JSX.Element {
  return (
    <div className="grid place-items-center px-6 py-20">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center space-y-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">403</p>
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">You don&apos;t have access to this</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">
          This page exists, but your role in this workspace can&apos;t open it. An owner or admin can
          grant access — or you may be looking at the wrong workspace.
        </p>
        <Link
          href="/applications"
          className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          Back to applications
        </Link>
      </div>
    </div>
  );
}
