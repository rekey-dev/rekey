/**
 * Inline status/error banner rendered from `?error=` / status query params
 * (the server-action redirect convention — see lib/actions.ts).
 *
 * Colors come from the semantic tokens (globals.css); soft fills/borders are
 * derived with color-mix because Tailwind 3 can't apply an opacity modifier
 * to a var() arbitrary value.
 *
 * Accessibility: `error` renders with role="alert"; the other tones use
 * aria-live="polite".
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
      ? 'border-[color-mix(in_srgb,var(--color-success)_25%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--color-success)]'
      : tone === 'error'
        ? 'border-[color-mix(in_srgb,var(--color-danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]'
        : 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-muted-fg)]';
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      aria-live={tone === 'error' ? undefined : 'polite'}
      className={`rounded-md border px-3 py-2 text-sm ${styles}`}
    >
      {children}
    </div>
  );
}
