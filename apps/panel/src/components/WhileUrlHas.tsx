'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Renders its (server-rendered) children only while the URL still carries
 * `param`.
 *
 * A refusal redirects back with `?error=CODE` and the page draws its banner
 * from that. A successful mint then revalidates without redirecting, so the
 * server render still sees the old `?error=` and would keep telling the
 * operator their key was refused next to the key they just got.
 * `RevealActionForm` drops the flag with `history.replaceState` on success,
 * which Next feeds back into `useSearchParams`, and this is what lets that
 * reach the banner without a navigation.
 */
export function WhileUrlHas({ param, children }: { param: string; children: React.ReactNode }): React.ReactNode {
  const search = useSearchParams();
  return search.has(param) ? children : null;
}
