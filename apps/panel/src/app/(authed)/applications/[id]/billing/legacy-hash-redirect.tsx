'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sends an old in-page anchor to the tab that replaced it. The checkout page
 * settings lived at `/billing#checkout-page` before the tabs, and a fragment
 * never reaches the server, so only the browser can move that bookmark on.
 */
export function LegacyHashRedirect({ hash, to }: { hash: string; to: string }): null {
  const router = useRouter();
  React.useEffect(() => {
    if (window.location.hash === hash) router.replace(to);
  }, [hash, to, router]);
  return null;
}
