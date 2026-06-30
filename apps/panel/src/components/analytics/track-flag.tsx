'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    const flag = params.get('e');
    if (!flag) return;

    const mapped = FLAG_EVENTS[flag];
    if (mapped) track(mapped.event, mapped.params);

    // Drop only the `e` param; keep anything else on the URL (e.g. ?reveal=).
    const next = new URLSearchParams(params.toString());
    next.delete('e');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  return null;
}
