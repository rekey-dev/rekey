import * as React from 'react';
import { CardSkeleton, TableSkeleton } from '@/components/Skeleton';

/**
 * Billing tab body while a tab loads. Sits inside the billing layout, so the
 * header and tab strip stay on screen and only the body is replaced.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-5">
      <CardSkeleton />
      <TableSkeleton rows={4} />
    </div>
  );
}
