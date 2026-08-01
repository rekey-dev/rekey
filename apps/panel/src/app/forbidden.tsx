import * as React from 'react';
import Link from 'next/link';

/**
 * Root 403. Rendered when `lib/api.ts` turns an API 403 into `forbidden()`.
 *
 * Distinct from 404 on purpose: "you're signed in, this exists, your role
 * can't see it" is a different answer from "no such thing", and it points at
 * a different fix (ask an owner) than "check the URL". Both used to land on
 * the generic error boundary, which said the panel was broken and offered a
 * "Try again" that could never succeed.
 */
export default function Forbidden(): React.JSX.Element {
  return (
    <main className="min-h-screen grid place-items-center px-6 bg-[var(--color-bg)]">
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
    </main>
  );
}
