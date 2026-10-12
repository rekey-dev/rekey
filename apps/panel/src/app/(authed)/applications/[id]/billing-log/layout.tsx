/**
 * Billing log shell: a heading and a tab strip over three views of one
 * Application's billing history.
 *
 *   Log                 every money change and pricing decision, newest first
 *   Default price used  how often a buyer was charged the default price
 *                       because their currency could not be charged
 *   Reconciliation      where the log and the money records disagree
 *
 * This is not the provider webhooks list under Billing, Setup: that shows what
 * providers posted. This shows what Rekey did about it, and why.
 */

import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { SegmentedNav } from '@/components/SegmentedNav';

export default async function BillingLogLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const base = `/applications/${id}/billing-log`;

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <PageHeader
          level={2}
          title="Billing log"
          description="Every money change and pricing decision for this Application, with why it happened. Payments, refunds and subscriptions stay the record of what is owed; this is the trail of how they got there."
        />
        <SegmentedNav
          label="Billing log views"
          segments={[
            { href: base, label: 'Log', exact: true },
            { href: `${base}/fallbacks`, label: 'Default price used' },
            { href: `${base}/reconciliation`, label: 'Reconciliation' },
          ]}
        />
      </div>
      <div>{children}</div>
    </div>
  );
}
