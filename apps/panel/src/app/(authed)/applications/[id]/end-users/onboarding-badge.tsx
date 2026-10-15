import * as React from 'react';
import { Badge } from '@/components/Badge';
import type { EndUserRow } from '@/lib/api';

/** Completed, skipped (a real answer, not a failure) or still pending. */
export function OnboardingBadge({ status }: { status: EndUserRow['onboardingStatus'] }): React.JSX.Element {
  if (status === 'completed') return <Badge tone="success" dot>completed</Badge>;
  if (status === 'skipped') return <Badge tone="neutral">skipped</Badge>;
  return <Badge tone="warning">pending</Badge>;
}
