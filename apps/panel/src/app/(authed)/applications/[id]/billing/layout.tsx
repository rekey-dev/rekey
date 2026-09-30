/**
 * Billing setup shell: a heading and a tab strip over five jobs.
 *
 *   Status         is billing on, and is anything stopping a buyer from paying
 *   Providers      which payment providers are connected, and their webhooks
 *   Checkout page  where buyers pay, and whether the Rekey page is ready
 *   Events         what the providers have posted to Rekey
 *   Settings       who pays, and whether Rekey chases failed payments
 *
 * These used to be one scroll in which the provider table sat below a tall
 * checkout readiness report. Tabs are route segments, as on the end-user
 * screen, so each one has a URL an operator can paste, and each action
 * redirects back to the tab it was made on.
 *
 * AppNav above already says Billing › Setup, so no tab here repeats a label
 * from those two rows: the first tab is Status, not a second Overview.
 *
 * Only static chrome lives here. Anything that changes when an action runs,
 * like the enabled state or the notices, is rendered by the tab itself, since
 * a layout is not guaranteed to re-render when the page below it does.
 */

import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { SegmentedNav } from '@/components/SegmentedNav';

export default async function BillingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const base = `/applications/${id}/billing`;

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <PageHeader
          level={2}
          title="Billing setup"
          description="Turn billing on, connect the providers that take payments, and choose how buyers check out."
        />
        <SegmentedNav
          label="Billing setup sections"
          segments={[
            { href: base, label: 'Status', exact: true },
            { href: `${base}/providers`, label: 'Providers' },
            { href: `${base}/checkout`, label: 'Checkout page' },
            { href: `${base}/events`, label: 'Events' },
            { href: `${base}/settings`, label: 'Settings' },
          ]}
        />
      </div>

      <div>{children}</div>
    </div>
  );
}
