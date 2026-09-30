import * as React from 'react';
import { HeaderSkeleton } from '@/components/Skeleton';
import { TopSkeleton } from './skeletons';

export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-5">
      <div className="animate-pulse">
        <HeaderSkeleton />
      </div>
      <TopSkeleton />
    </div>
  );
}
