'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { track, FLAG_EVENTS } from '@/lib/analytics';

/**
 * Turns a one-shot `?e=<flag>` success-redirect param into a GA4 event, then
 * strips it so refresh/back doesn't double-count. Server actions run
 * server-side and end in redirect(), so they can't call gtag directly — they
 * hand the event off via this flag instead. Mounted once in the root layout,
 * inside <Suspense> (useSearchParams requirement), so it covers every route.
 */
export function TrackFlag(): null {
  const params = useSearchParams();
  const pathname = usePathname();

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const flag = params.get('e');
    if (!flag) return;

    const mapped = FLAG_EVENTS[flag];
    if (mapped) track(mapped.event, mapped.params);

    // Drop only the `e` param; keep anything else on the URL (e.g. ?reveal=).
    const next = new URLSearchParams(params.toString());
    next.delete('e');
    const qs = next.toString();
    // history.replaceState, not router.replace: this only ever wanted to tidy
    // the address bar. Next 15 feeds a native history edit back into
    // useSearchParams, so the URL and the hooks stay in sync without kicking
    // off a navigation — and a navigation here would race the one the server
    // action's own redirect is already running, into a router cache that
    // action just emptied. That race is what left the page blank.
    window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname);
  }, [params, pathname]);

  return null;
}
