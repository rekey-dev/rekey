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
 *
 * ## This map is the CANONICAL one for the whole product
 *
 * Two more copies exist, because neither app can import from here:
 *   - `apps/portal/src/components/status-badge.tsx` (customer-facing)
 *   - the super-admin dashboard’s Badge component
 *
 * They had drifted to the point of contradiction — `CANCELED` was grey in the
 * panel and the portal but RED in admin, on an app whose own `environmentTone`
 * docblock says it "reserves red for things that need attention"; `PAST_DUE`
 * was amber for the operator and red for the customer, so the same account
 * looked routine to support and alarming to the person paying. The three copies
 * are now byte-identical in meaning, and each carries a pointer to this one.
 * Change a status here first, then mirror it.
 *
 * The tone vocabulary itself:
 *   success — a good resting state; nothing to do.
 *   warning — needs attention, has not failed yet. Recoverable.
 *   danger  — a failure or a revocation. Red is for things that are wrong,
 *             never for things that merely ended.
 *   neutral — an ended or reversed state that is nobody's problem. `CANCELED`,
 *             `EXPIRED` and `REFUNDED` all live here: a customer choosing to
 *             leave is not a fault, and colouring it red trains operators to
 *             ignore red.
 */

const TONES: Record<string, BadgeTone> = {
  // Money
  SUCCEEDED: 'success',
  PENDING: 'warning',
  PROCESSING: 'warning',
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
  DELIVERED: 'success',
  PROCESSED: 'success',
  // Invitations
  ACCEPTED: 'success',
  // Service health (rendered by the admin app; kept here so the canonical map
  // is complete and the three copies can stay identical).
  OK: 'success',
  UP: 'success',
  DOWN: 'danger',
  NOT_CONFIGURED: 'neutral',
};

/** `PAST_DUE` → `Past due`. */
export function statusLabel(status: string): string {
  // `/_/g`, not `'_'`: a non-global replace only rewrites the FIRST underscore,
  // so a two-underscore enum (`NOT_CONFIGURED`) came out as `Not configured`
  // in one app and `Not_configured` in another. Cheap bug, easy to re-introduce.
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
