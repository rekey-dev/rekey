import * as React from 'react';
import { PageSkeleton } from '@/components/Skeleton';

/**
 * Segment-level loading state for every authed route (WP15). Specific
 * heavy routes override with their own loading.tsx where the layout
 * differs (applications list, app detail).
 */
export default function Loading(): React.JSX.Element {
  return <PageSkeleton />;
}
