/**
 * Status badge — design.md §4 status colors, applied to subscription and
 * payment states. Status dots stay small (w-1.5 h-1.5) and unobtrusive.
 *
 * Tones follow the panel <Badge> convention: a soft 10% tint fill + a readable
 * foreground carrying the meaning. Success/danger drive off the semantic
 * tokens (globals.css); tints use color-mix because Tailwind 3 can't apply an
 * opacity modifier to a var() arbitrary value.
 */

import type { ReactNode } from 'react';

type Tone = 'success' | 'warning' | 'danger' | 'idle';

const TONES: Record<Tone, { chip: string; dot: string }> = {
  success: {
    chip: 'bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--color-success)]',
    dot: 'bg-[var(--color-success)]',
  },
  warning: { chip: 'bg-amber-500/10 text-amber-700', dot: 'bg-amber-500' },
  danger: {
    chip: 'bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]',
    dot: 'bg-[var(--color-danger)]',
  },
  idle: { chip: 'bg-[var(--color-surface-muted)] text-[var(--color-muted-fg)]', dot: 'bg-[var(--color-faint-fg)]' },
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
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}
