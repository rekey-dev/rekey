/**
 * Route-level loading skeleton — shown while the dashboard's server render
 * awaits the subscription / plans / providers fetches. Mirrors the real layout
 * (two cards) so the page doesn't jump when content arrives.
 */

import * as React from 'react';
import { Card } from '@/components/card';

function SkeletonCard({ rows }: { rows: number }): React.JSX.Element {
  return (
    <Card>
      <div className="mb-4 h-4 w-28 animate-pulse rounded bg-[var(--color-bg)]" />
      <div className="space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded-md bg-[var(--color-bg)]" />
        ))}
      </div>
    </Card>
  );
}

export default function DashboardLoading(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <SkeletonCard rows={2} />
      <SkeletonCard rows={3} />
    </div>
  );
}
