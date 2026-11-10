'use client';

/**
 * Header nav item with its active state. Client component only for
 * usePathname, keep it tiny.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({
  href,
  exact = false,
  children,
}: {
  href: string;
  /** Active on this path only, not on the pages under it. */
  exact?: boolean;
  children: ReactNode;
}): ReactNode {
  const pathname = usePathname();
  const active = pathname === href || (!exact && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'inline-flex min-h-11 items-center whitespace-nowrap rounded-md bg-[var(--color-primary-soft)] px-3 text-sm font-medium text-[var(--color-primary-soft-fg)]'
          : 'inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
      }
    >
      {children}
    </Link>
  );
}
