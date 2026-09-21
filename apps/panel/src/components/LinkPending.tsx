'use client';

/**
 * Immediate feedback on a navigation link that has been clicked but whose page
 * has not arrived yet.
 *
 * With prefetching off (see `components/Link.tsx`), a click waits for the
 * server before the destination's `loading.tsx` skeleton can show. That wait
 * is usually short, but it is a round trip to the panel server, and on a busy
 * API the page behind it can take longer. Without a signal the operator reads
 * the unchanged screen as "my click did nothing" and clicks again.
 *
 * `useLinkStatus` reports pending for the enclosing `<Link>` only, so this has
 * to be rendered INSIDE the link, wrapping its label. It changes opacity and
 * nothing else, so it cannot shift the tab strip's layout.
 */

import * as React from 'react';
import { useLinkStatus } from 'next/link';

export function LinkPending({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { pending } = useLinkStatus();
  return (
    <span className={pending ? 'opacity-60 transition-opacity duration-150' : 'transition-opacity duration-150'}>
      {children}
    </span>
  );
}
