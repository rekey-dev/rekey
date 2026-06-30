import * as React from 'react';

/**
 * Zero / empty-state block. Replaces the two slightly-different dashed-border
 * empty states pages were hand-rolling (`border-2 border-dashed … p-10/p-12
 * text-center`) plus the plain "No X yet" card. One consistent, calm shell with
 * an optional title, body copy, an action (create button / modal trigger), and
 * an optional leading icon.
 *
 * `variant="card"` (default) is the dashed placeholder used where a list would
 * be; `variant="inline"` is the quieter solid-border card for read-only views
 * (audit log, "no invitations") that don't invite an action.
 */

export function EmptyState({
  title,
  description,
  action,
  icon,
  variant = 'card',
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  variant?: 'card' | 'inline';
  className?: string;
}): React.JSX.Element {
  const shell =
    variant === 'card'
      ? 'rounded-xl border-2 border-dashed border-[var(--color-border)] px-6 py-12'
      : 'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10';
  return (
    <div className={`${shell} flex flex-col items-center text-center ${className}`}>
      {icon && <div className="mb-3 text-[var(--color-faint-fg)]">{icon}</div>}
      <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-md text-sm text-[var(--color-muted-fg)]">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
