import * as React from 'react';

type Tone = 'default' | 'positive' | 'warning' | 'danger' | 'info';

const STYLES: Record<Tone, string> = {
  default: 'bg-[var(--color-surface-muted)] text-[var(--color-muted-fg)] border-[var(--color-border)]',
  positive: 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success)]/30',
  warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]/30',
  danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[var(--color-danger)]/30',
  info: 'bg-[var(--color-primary-soft)] text-[var(--color-primary-soft-fg)] border-[var(--color-primary)]/30',
};

export function Badge({
  children,
  tone = 'default',
  className = '',
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${STYLES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Map common subscription/payment status strings to tones. */
export function statusTone(status: string): Tone {
  const s = status.toUpperCase();
  if (s === 'ACTIVE' || s === 'SUCCEEDED' || s === 'DELIVERED' || s === 'PROCESSED' || s === 'OK' || s === 'UP') return 'positive';
  if (s === 'PENDING' || s === 'PAST_DUE' || s === 'PROCESSING') return 'warning';
  if (s === 'FAILED' || s === 'CANCELED' || s === 'CANCELLED' || s === 'EXPIRED' || s === 'REFUNDED' || s === 'DOWN' || s === 'REVOKED') return 'danger';
  return 'default';
}

/**
 * Application environment → tone. Deliberately not `danger` for PRODUCTION:
 * this is a label for what an application IS, not a fault, and the admin app
 * reserves red for things that need attention.
 */
export function environmentTone(environment: string): Tone {
  if (environment === 'PRODUCTION') return 'info';
  if (environment === 'STAGING') return 'warning';
  return 'default';
}
