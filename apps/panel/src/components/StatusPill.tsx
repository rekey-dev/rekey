import * as React from 'react';
import { Badge, type BadgeTone } from '@/components/Badge';

/**
 * One status pill for every status anywhere in the panel.
 *
 * The same payment status rendered two ways depending on which page you were
 * on: uppercase `FAILED` on /payments, title-case `Failed` on /revenue, driven
 * by two separate tone maps and two separate label maps that had drifted apart.
 * Dunning had a third pair. A reader comparing the pages had to work out
 * whether `FAILED` and `Failed` were the same state.
 *
 * Both the tone and the label are derived here from the raw API enum, so a new
 * status added server-side renders sensibly (title-cased, neutral) instead of
 * appearing as a bare screaming enum, and no page can drift again.
 *
 * Case is deliberately title, not upper: an all-caps word inside prose-weight
 * UI reads as shouting, and these appear in dense tables next to email
 * addresses and amounts.
 */

const TONES: Record<string, BadgeTone> = {
  // Money
  SUCCEEDED: 'success',
  PENDING: 'warning',
  FAILED: 'danger',
  REFUNDED: 'neutral',
  // Subscriptions
  ACTIVE: 'success',
  PAST_DUE: 'warning',
  CANCELED: 'neutral',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  // Dunning cases
  OPEN: 'warning',
  RECOVERED: 'success',
  EXHAUSTED: 'danger',
  // Licences / keys
  REVOKED: 'danger',
  SUSPENDED: 'danger',
  // Webhook deliveries reuse SUCCEEDED / PENDING / FAILED above.
  // Invitations
  ACCEPTED: 'success',
};

/** `PAST_DUE` → `Past due`. */
export function statusLabel(status: string): string {
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function statusTone(status: string): BadgeTone {
  return TONES[status.toUpperCase()] ?? 'neutral';
}

export function StatusPill({
  status,
  dot = true,
  className,
}: {
  /** The raw enum from the API — never pre-formatted by the caller. */
  status: string;
  dot?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <Badge tone={statusTone(status)} dot={dot} className={className} >
      {statusLabel(status)}
    </Badge>
  );
}
