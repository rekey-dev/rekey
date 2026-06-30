'use client';

import * as React from 'react';
import { fmtDateTime } from '@/lib/format';

/**
 * Render a timestamp in the operator's local timezone, with the UTC form as
 * a tooltip. SSR-safe: the initial paint uses the UTC string (deterministic
 * across server + client) and switches to local time once React mounts. This
 * avoids the "Text content did not match" hydration warning that would fire
 * if we tried to render local time directly on the server (the server's
 * timezone is UTC, the client's isn't).
 */
export function DateTime({ iso }: { iso: string | null | undefined }): React.JSX.Element {
  const [local, setLocal] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    // Use the user's locale + timezone. `dateStyle: 'short' + timeStyle: 'short'`
    // gives a compact, locale-aware shape (e.g. "31/05/2026, 18:55" in en-GB,
    // "5/31/2026, 6:55 PM" in en-US).
    setLocal(d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }));
  }, [iso]);

  if (!iso) return <span>—</span>;
  const utc = fmtDateTime(iso);
  return (
    <span title={`UTC: ${utc}`} suppressHydrationWarning>
      {local ?? utc}
    </span>
  );
}
