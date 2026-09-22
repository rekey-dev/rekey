'use client';

import * as React from 'react';
import { noteCommittedRender } from '@/lib/render-stamp';

/**
 * Records, on commit, the id the authed layout minted for this server render.
 * See `lib/render-stamp.ts` and `lib/commit-nudge.ts`.
 */
export function RenderStamp({ stamp }: { stamp: string }): null {
  React.useLayoutEffect(() => {
    noteCommittedRender(stamp);
  }, [stamp]);
  return null;
}
