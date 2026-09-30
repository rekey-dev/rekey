/**
 * Team shell: header and a tab strip over three jobs.
 *
 *   Members             who is in this workspace, and their workspace role
 *   Application access  which applications each member reaches, and what they may do there
 *   Invitations         inviting someone, and the invitations still open
 *
 * One page used to stack all three, so the invite form sat below every
 * member's scope editor. The tabs are route segments, as on the end-user
 * screen, and each action redirects back to its own tab. Only static chrome
 * lives here; anything an action changes is rendered by the tab.
 */

import * as React from 'react';
import { getMe } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { SegmentedNav } from '@/components/SegmentedNav';
import { InviteAction } from './invite-action';

export default async function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const me = await getMe();
  const canManage = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  const workspaceName = me.memberships.find((m) => m.tenantId === me.activeTenantId)?.tenantName;

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <div className="space-y-4">
        <PageHeader
          title="Team"
          description={
            <>
              People who can sign in to{' '}
              <strong className="font-medium text-[var(--color-fg)]">{workspaceName}</strong>, and
              what each of them can reach.
            </>
          }
          action={canManage ? <InviteAction /> : undefined}
        />
        <SegmentedNav
          label="Team sections"
          segments={[
            { href: '/team', label: 'Members', exact: true },
            { href: '/team/access', label: 'Application access' },
            // Invitations are OWNER/ADMIN data; the API refuses a MEMBER.
            ...(canManage ? [{ href: '/team/invitations', label: 'Invitations' }] : []),
          ]}
        />
      </div>

      <div>{children}</div>
    </section>
  );
}
