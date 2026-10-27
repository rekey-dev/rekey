/**
 * Account shell: the pages about you rather than the workspace, under one
 * header and one tab strip. They follow you into every workspace you belong to.
 *
 * Confirm-email sits outside this route group: it is where an unconfirmed
 * operator lands, and the tabs would offer pages that operator cannot use yet.
 */

import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { SegmentedNav } from '@/components/SegmentedNav';

export default function AccountLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <div className="space-y-4">
        <PageHeader title="Account" description="Your sign-in, your personal keys, and what you have called with them." />
        <SegmentedNav
          label="Account sections"
          segments={[
            { href: '/account/security', label: 'Security' },
            { href: '/account/passkeys', label: 'Passkeys' },
            { href: '/account/api-tokens', label: 'API tokens' },
            { href: '/account/mcp', label: 'AI assistants (MCP)' },
            { href: '/account/activity', label: 'My requests' },
          ]}
        />
      </div>

      <div>{children}</div>
    </section>
  );
}
