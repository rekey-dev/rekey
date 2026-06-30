import * as React from 'react';
import Link from 'next/link';
import { EmptyState } from './EmptyState';

/**
 * Shared "billing is off" placeholder for the billing-group pages (plans,
 * coupons, licenses, payments, usage, dunning). The Billing tab group is
 * hidden while billing is disabled, but the routes stay reachable by URL —
 * instead of an empty table, point the operator at the master switch.
 * Mirrors the guard the Revenue page already renders.
 */
export function BillingDisabledState({
  applicationId,
}: {
  applicationId: string;
}): React.JSX.Element {
  return (
    <EmptyState
      title="Billing isn't enabled"
      description="Turn on billing and connect a provider to use plans, coupons, usage, and payments."
      action={
        <Link
          href={`/applications/${applicationId}/billing`}
          className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
        >
          Go to billing settings
        </Link>
      }
    />
  );
}
