/**
 * Status badge, design.md §4 status colors, applied to subscription and
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
 *     customer reading it. Past-due IS the grace period, the subscription is
 *     still live and a retry may yet succeed, so amber is the honest colour
 *     for both audiences, and red here was a fright shown to someone whose card
 *     had merely expired.
 *   - The label rendered `past due` (lowercase) against `Past due` in the
 *     panel. Labels now come from a copy map, so an enum name never reaches
 *     the customer.
 */

import type { ReactNode } from 'react';

type Tone = 'success' | 'warning' | 'danger' | 'idle';

const TONES: Record<Tone, { chip: string; dot: string }> = {
  success: {
    chip: 'bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--color-success)]',
    dot: 'bg-[var(--color-success)]',
  },
  warning: {
    chip: 'bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)]',
    dot: 'bg-[var(--color-warning)]',
  },
  danger: {
    chip: 'bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]',
    dot: 'bg-[var(--color-danger)]',
  },
  idle: { chip: 'bg-[var(--color-surface-muted)] text-[var(--color-muted-fg)]', dot: 'bg-[var(--color-faint-fg)]' },
};

/**
 * Mirror of `TONES` in the panel's StatusPill, restricted to the statuses a
 * customer can actually be shown, with the words a customer reads for each.
 * `idle` is this file's name for the panel's `neutral`: an ended or reversed
 * state that is nobody's fault.
 */
const STATUSES: Record<string, { tone: Tone; label: string }> = {
  // Subscription
  ACTIVE: { tone: 'success', label: 'Active' },
  TRIALING: { tone: 'success', label: 'Trial' },
  PENDING: { tone: 'warning', label: 'Pending' },
  PROCESSING: { tone: 'warning', label: 'Processing' },
  PAST_DUE: { tone: 'warning', label: 'Past due' },
  CANCELED: { tone: 'idle', label: 'Canceled' },
  EXPIRED: { tone: 'idle', label: 'Expired' },
  SUSPENDED: { tone: 'danger', label: 'Suspended' },
  // Payment
  SUCCEEDED: { tone: 'success', label: 'Paid' },
  FAILED: { tone: 'danger', label: 'Failed' },
  REFUNDED: { tone: 'idle', label: 'Refunded' },
  PARTIALLY_REFUNDED: { tone: 'idle', label: 'Partially refunded' },
};

/** The customer-facing word for a status. A status this list does not name reads as unknown, never as its enum. */
export function statusLabel(status: string): string {
  return STATUSES[status.toUpperCase()]?.label ?? 'Unknown';
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  const tone = TONES[STATUSES[status.toUpperCase()]?.tone ?? 'idle'];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
      {statusLabel(status)}
    </span>
  );
}
