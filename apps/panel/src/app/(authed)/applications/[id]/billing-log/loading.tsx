import * as React from 'react';
import { TableSkeleton } from '@/components/Skeleton';

/** Billing log body while a view loads. The heading and the view strip stay on screen. */
export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-5">
      <TableSkeleton rows={8} />
    </div>
  );
}
