import * as React from 'react';
import { TableSkeleton } from '@/components/Skeleton';

/**
 * Email sub-tab body while it loads. Inside `email/layout.tsx`, so the heading
 * and the Settings / Templates / Delivery / Suppressions strip stay put. The
 * nearest boundary above this one (`applications/[id]/loading.tsx`) does not
 * re-trigger for a switch between these sub-tabs, which left the previous one
 * frozen on screen with no sign the click had registered.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-5">
      <TableSkeleton rows={5} />
    </div>
  );
}
