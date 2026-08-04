'use client';

/**
 * Per-app error boundary. Catches everything BELOW `[slug]/layout.tsx`, so the
 * merchant's own header — their name, their logo, their colours — stays on
 * screen and the customer never loses the sense of whose site they are on.
 *
 * The dashboard under here does four billing reads (`page.tsx`); any one of
 * them throwing used to take the whole render down to Next's default error
 * page. Layout-level failures (the config fetch itself) fall through to
 * `app/error.tsx` instead, which repeats this copy without the branding it
 * could not resolve.
 *
 * Same audience rules as not-found.tsx: no codes, no operator instructions.
 */

import * as React from 'react';
import { Card } from '@/components/card';

export default function SlugError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card className="text-center">
      <h1 className="text-base font-semibold text-[var(--color-fg)]">
        We couldn&apos;t load your account just now
      </h1>
      <p className="mx-auto mt-3 max-w-sm text-sm text-[var(--color-muted-fg)]">
        This is a problem on our side. Your subscription and payment details are unaffected —
        nothing has been charged or changed. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-5 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
      >
        Try again
      </button>
    </Card>
  );
}
