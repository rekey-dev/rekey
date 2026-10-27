import * as React from 'react';
import { PageSkeleton } from '@/components/Skeleton';

/**
 * Loading state for a switch between account pages (security, passkeys, API
 * tokens, MCP, activity).
 *
 * `(authed)/loading.tsx` covers arriving at `/account/*` from elsewhere, but
 * not a move from one account page to another: the `account` segment itself
 * does not change, so its boundary stays resolved and the old page stayed on
 * screen until the new one had rendered. This boundary sits one level down and
 * is keyed on the page, so it shows on every switch.
 */
export default function Loading(): React.JSX.Element {
  return <PageSkeleton />;
}
