'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import Link from '@/components/Link';

const INVITATIONS = '/team/invitations';

/**
 * The header's "Invite a teammate" button. Hidden on the Invitations tab,
 * where the invite form is the first thing on the page and a button linking
 * to the page you are already on would do nothing.
 */
export function InviteAction(): React.JSX.Element | null {
  if (usePathname() === INVITATIONS) return null;
  return (
    <Link
      href={INVITATIONS}
      className="inline-flex rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2"
    >
      Invite a teammate
    </Link>
  );
}
