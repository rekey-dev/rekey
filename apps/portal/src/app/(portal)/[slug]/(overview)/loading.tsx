/**
 * The dashboard's loading skeleton, shown while its server render awaits the
 * subscription, plans and payments. It lives in the dashboard's own route
 * group so the sign-in and password pages never flash a dashboard. Mirrors the
 * real layout (two cards) so the page doesn't jump when content arrives.
 */

import * as React from 'react';
import { Card } from '@/components/card';

function SkeletonCard({ rows }: { rows: number }): React.JSX.Element {
  return (
    <Card>
      <div className="mb-4 h-4 w-28 animate-pulse rounded bg-[var(--color-border)]" />
      <div className="space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded-md bg-[var(--color-border)]" />
        ))}
      </div>
    </Card>
  );
}

export default function DashboardLoading(): React.JSX.Element {
  return (
    <div className="space-y-6" aria-busy="true">
      <p role="status" className="sr-only">
        Loading your account
      </p>
      <SkeletonCard rows={2} />
      <SkeletonCard rows={3} />
    </div>
  );
}
