'use client';

/**
 * Sidebar/topbar nav item with active state. Client component only for
 * usePathname — keep it tiny.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={
        active
          ? 'rounded-md bg-[var(--color-primary-soft)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-soft-fg)]'
          : 'rounded-md px-3 py-1.5 text-sm text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
      }
    >
      {children}
    </Link>
  );
}
