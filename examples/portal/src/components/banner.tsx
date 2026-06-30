/**
 * Inline status/error banner rendered from `?error=` / status query params
 * (the server-action redirect convention — see lib/actions.ts).
 */

import type { ReactNode } from 'react';

export function Banner({
  tone,
  children,
}: {
  tone: 'success' | 'error' | 'info';
  children: ReactNode;
}): ReactNode {
  const styles =
    tone === 'success'
      ? 'border-green-200 bg-green-50 text-green-800'
      : tone === 'error'
        ? 'border-red-200 bg-red-50 text-red-800'
        : 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-muted-fg)]';
  return <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>{children}</div>;
}
