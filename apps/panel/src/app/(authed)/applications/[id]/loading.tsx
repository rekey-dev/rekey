import * as React from 'react';
import { CardSkeleton, HeaderSkeleton, TableSkeleton } from '@/components/Skeleton';

/**
 * App-section loading state — rendered inside the app layout (header +
 * AppNav stay visible), so only the page body skeletons.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-5">
      <HeaderSkeleton />
      <CardSkeleton />
      <TableSkeleton rows={4} />
    </div>
  );
}
