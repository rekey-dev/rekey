/**
 * Status badge — design.md §4 status colors, applied to subscription and
 * payment states. Status dots stay small (w-1.5 h-1.5) and unobtrusive.
 */

import type { ReactNode } from 'react';

type Tone = 'success' | 'warning' | 'danger' | 'idle';

const TONES: Record<Tone, { dot: string; text: string }> = {
  success: { dot: 'bg-green-600', text: 'text-green-700' },
  warning: { dot: 'bg-amber-600', text: 'text-amber-700' },
  danger: { dot: 'bg-red-600', text: 'text-red-700' },
  idle: { dot: 'bg-neutral-400', text: 'text-neutral-500' },
};

const STATUS_TONE: Record<string, Tone> = {
  // Subscription
  ACTIVE: 'success',
  PENDING: 'warning',
  PAST_DUE: 'danger',
  CANCELED: 'idle',
  EXPIRED: 'idle',
  // Payment
  SUCCEEDED: 'success',
  FAILED: 'danger',
  REFUNDED: 'idle',
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  const tone = TONES[STATUS_TONE[status] ?? 'idle'];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs font-medium ${tone.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}
