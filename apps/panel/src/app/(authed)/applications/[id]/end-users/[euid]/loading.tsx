import * as React from 'react';
import { CardSkeleton, TableSkeleton } from '@/components/Skeleton';

/**
 * End-user tab body while a tab loads.
 *
 * Inside `[euid]/layout.tsx`, so the identity header and the tab strip stay on
 * screen and only the body is replaced. Without it a tab switch had no boundary
 * nearer than `applications/[id]/loading.tsx`, which does not re-trigger for a
 * change BELOW the end-users segment, so the old tab stayed frozen on screen
 * until the new one had finished every API call it makes (five on
 * Subscriptions, eight on the overview).
 *
 * Next keys the boundary on the child segment, so it shows on every switch
 * between tabs, including back to the overview.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-5">
      <CardSkeleton />
      <TableSkeleton rows={4} />
    </div>
  );
}
