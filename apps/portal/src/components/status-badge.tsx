/**
 * Status badge — design.md §4 status colors, applied to subscription and
 * payment states. Status dots stay small (w-1.5 h-1.5) and unobtrusive.
 *
 * Tones follow the panel <Badge> convention: a soft 10% tint fill + a readable
 * foreground carrying the meaning. Success/danger drive off the semantic
 * tokens (globals.css); tints use color-mix because Tailwind 3 can't apply an
 * opacity modifier to a var() arbitrary value.
 *
 * ## The tone map here is a MIRROR, not an opinion
 *
 * Canonical source: `apps/panel/src/components/StatusPill.tsx`. Copied rather
 * than imported because the two apps share no package. Change it there first.
 *
 * Two things used to disagree with it, and both mattered:
 *
 *   - `PAST_DUE` was `danger` here and `warning` in the panel, so the same
 *     account looked routine to the operator handling it and alarming to the
 *     customer reading it. Past-due IS the grace period — the subscription is
 *     still live and a retry may yet succeed — so amber is the honest colour
 *     for both audiences, and red here was a fright shown to someone whose card
 *     had merely expired.
 *   - The label rendered `past due` (lowercase) against `Past due` in the
 *     panel, via a NON-GLOBAL `replace('_', ' ')` that rewrites only the first
 *     underscore and so mangles any two-underscore enum.
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

/**
 * Mirror of `TONES` in the panel's StatusPill, restricted to the statuses a
 * customer can actually be shown. `idle` is this file's name for the panel's
 * `neutral`: an ended or reversed state that is nobody's fault.
 */
const STATUS_TONE: Record<string, Tone> = {
  // Subscription
  ACTIVE: 'success',
  PENDING: 'warning',
  PROCESSING: 'warning',
  PAST_DUE: 'warning',
  CANCELED: 'idle',
  CANCELLED: 'idle',
  EXPIRED: 'idle',
  SUSPENDED: 'danger',
  // Payment
  SUCCEEDED: 'success',
  FAILED: 'danger',
  REFUNDED: 'idle',
};

/** `PAST_DUE` → `Past due`. Mirror of `statusLabel` in the panel's StatusPill. */
export function statusLabel(status: string): string {
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  const tone = TONES[STATUS_TONE[status.toUpperCase()] ?? 'idle'];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
      {statusLabel(status)}
    </span>
  );
}
