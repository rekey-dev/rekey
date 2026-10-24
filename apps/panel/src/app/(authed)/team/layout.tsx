/**
 * Team shell: header and a tab strip over two jobs.
 *
 *   People      who is in this workspace or invited to it, and their role
 *   App access  which apps each member can use, and what they may do there
 *
 * Inviting happens from People, in a dialog, and pending invitations sit in
 * the same list as the people already in, so one screen answers "who has
 * access". Only static chrome lives here; anything an action changes is
 * rendered by the tab.
 */

import * as React from 'react';
import { getMe } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SegmentedNav } from '@/components/SegmentedNav';

export default async function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const me = await getMe();
  const workspaceName = me.memberships.find((m) => m.tenantId === me.activeTenantId)?.tenantName;

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <div className="space-y-4">
        <PageHeader
          title="Team"
          description={
            <>
              Who can sign in to{' '}
              <strong className="font-medium text-[var(--color-fg)]">{workspaceName}</strong>, and
              what each of them can do.
            </>
          }
        />
        <SegmentedNav
          label="Team sections"
          segments={[
            { href: '/team', label: 'People', exact: true },
            { href: '/team/access', label: 'App access' },
          ]}
        />
      </div>

      <div>{children}</div>
    </section>
  );
}
