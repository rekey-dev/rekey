'use client';

/**
 * Root error boundary for the hosted portal.
 *
 * This is the boundary that catches `[slug]/layout.tsx` — and that layout's
 * very first act is `getPortalConfig(slug)`, which THROWS on any non-404 HTTP
 * response from the API (`lib/config.ts`). One API blip, one 502 from the edge,
 * one restart mid-deploy, and without a boundary here the person looking at the
 * screen gets Next's default error page: a bare stack-trace shell in
 * development, an unstyled "Application error: a client-side exception has
 * occurred" in production.
 *
 * The audience is what makes this urgent. It is not the operator — it is the
 * MERCHANT'S PAYING CUSTOMER, on the same app whose not-found.tsx is explicit
 * that no Rekey vocabulary, error code, or operator instruction may reach them.
 * A default Next error page fails every line of that rule at once.
 *
 * So the same audience rules apply here:
 *   - no error codes, no `digest`, no API `fix` text, no mention of an "API";
 *   - the only actions offered are ones this person can actually take;
 *   - "Powered by Rekey" stays a footer credit and nothing more.
 *
 * `reset()` re-renders the segment, which re-runs the config fetch — the right
 * affordance for the transient case that dominates here. There is deliberately
 * no "go home" link: the portal root is not a page a customer has any use for,
 * and every real portal address is `/<slug>`, which is where they already are.
 */

import * as React from 'react';
import { Card } from '@/components/card';

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    // Operator-side diagnostics only. Never rendered.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md px-5 pt-20 pb-10">
      <Card className="text-center">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">
          This page didn&apos;t load
        </h1>
        <p className="mt-3 text-sm text-[var(--color-muted-fg)]">
          Something went wrong on our side, not yours. Nothing you were doing has been
          charged or changed. Try again in a moment — if it keeps happening, contact the
          business you bought from.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-5 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          Try again
        </button>
      </Card>
      <p className="mt-8 text-center text-xs text-[var(--color-muted-fg)]">Powered by Rekey</p>
    </div>
  );
}
