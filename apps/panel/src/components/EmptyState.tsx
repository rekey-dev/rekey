import * as React from 'react';
import Link from '@/components/Link';

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

/**
 * The create button for an empty list, placed inside the empty state. It
 * opens the page's own create dialog through that dialog's `modalKey` flag,
 * so there is one form and two ways in.
 *
 * @example
 * <EmptyState title="No meters yet" action={<EmptyStateCreate modalKey="newMeter">New meter</EmptyStateCreate>} />
 */
export function EmptyStateCreate({
  modalKey,
  children,
}: {
  modalKey: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      href={`?${modalKey}=1`}
      scroll={false}
      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] transition-transform duration-150 ease-out hover:bg-[var(--color-primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] active:scale-[0.97]"
    >
      {children}
    </Link>
  );
}
