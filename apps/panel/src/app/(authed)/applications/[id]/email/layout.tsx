/**
 * Email shell. Its five tabs (Settings, Templates, Custom templates, Delivery,
 * Suppressions) are AppNav's second row, defined in `lib/app-sections.ts`.
 *
 * The per-event editor stays at `email/[eventKey]`. A static segment wins over
 * a dynamic sibling in the App Router, so `templates` and `suppressions` are
 * not swallowed by it.
 */

import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';

export default function EmailLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-5">
      <PageHeader
        level={2}
        title="Email"
        description="Transactional mail this Application sends to its end-users. Workspace mail (operator invitations and the like) is separate and is not affected by anything here."
      />
      <div>{children}</div>
    </div>
  );
}
