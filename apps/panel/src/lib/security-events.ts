/**
 * Security-event presentation: labels for the log, and CUID→email resolution.
 *
 * The label map used to live here as a panel-side MIRROR of a list nobody
 * owned, the API emits its event types as bare string literals at ~62 call
 * sites, and this file said so, with "it should live in
 * `@rekey.dev/shared-types` next to the emitters". It now does. The names below
 * are thin re-exports so the pages calling them did not have to change; new
 * code should import from `@rekey.dev/shared-types` directly.
 *
 * What stays here is the part that genuinely is panel-specific: the words
 * the panel puts around an event and its actor.
 */

export {
  SECURITY_EVENT_LABEL as EVENT_TYPE_LABEL,
  humanizeSecurityEventType as humanizeEventType,
  securityEventTypeOptions as eventTypeOptions,
  type SecurityEventType,
} from '@rekey.dev/shared-types';


// ────────────────────────────────────────────────────────────────────────────
// Metadata presentation
// ────────────────────────────────────────────────────────────────────────────

/** One chip rendered next to an event's label. */
export interface EventDetail {
  label: string;
  /** Display value, truncated for the cell. */
  value: string;
  /** The untruncated value, for the title. */
  full: string;
}

/**
 * The keys worth surfacing from `metadata`, in display order. The audit log
 * and Activity rendered the event type and actor only, so everything an event
 * actually said (which tool an agent called and under which scope, whether a
 * switch went on or off, which plan was granted and why) was written and shown
 * nowhere. Whitelisted rather than dumped: metadata routinely carries ids and
 * argument shapes that mean nothing in a table cell.
 */
const DETAIL_KEYS: ReadonlyArray<{ key: string; label: string; verbatim?: true }> = [
  { key: 'tool', label: 'tool' },
  { key: 'scope', label: 'scope' },
  { key: 'enabled', label: 'state' },
  { key: 'via', label: 'via' },
  { key: 'role', label: 'role' },
  { key: 'planSlug', label: 'plan' },
  // A grant made with an API key records the key only in metadata (its actor
  // is `system`), so without these the trail read "system, reason GRANT":
  // no key and no amount.
  // Verbatim: a key prefix is `rk_live_…`, and humanizing its underscores
  // would print a prefix that matches no key.
  { key: 'apiKeyName', label: 'key', verbatim: true },
  { key: 'keyPrefix', label: 'key prefix', verbatim: true },
  { key: 'amount', label: 'amount' },
  { key: 'reason', label: 'reason' },
  { key: 'note', label: 'note' },
  { key: 'admin', label: 'admin' },
  { key: 'write', label: 'write' },
];

const MAX_DETAILS = 5;
const MAX_VALUE_CHARS = 48;

export function eventDetails(metadata: unknown): EventDetail[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const m = metadata as Record<string, unknown>;
  const out: EventDetail[] = [];
  for (const { key, label, verbatim } of DETAIL_KEYS) {
    if (!(key in m)) continue;
    const v = m[key];
    let value: string | null = null;
    if (typeof v === 'string') value = verbatim ? v : v.replace(/_/g, ' ');
    else if (typeof v === 'number') value = String(v);
    else if (typeof v === 'boolean') {
      // `enabled` reads as a state; the other flags only matter when set.
      if (key === 'enabled') value = v ? 'on' : 'off';
      else if (v) value = 'yes';
    }
    if (value === null || value === '') continue;
    const full = value;
    if (value.length > MAX_VALUE_CHARS) value = value.slice(0, MAX_VALUE_CHARS - 1) + '…';
    out.push({ label, value, full });
    if (out.length === MAX_DETAILS) break;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Actor resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map of `actorId` → email, for the actors on one page of events.
 *
 * The API resolves it now (`actorEmail` on every event, looked up when the log
 * is read), including operators who have since left the workspace, which the
 * panel's own lookup against the current member list could never name. This
 * takes that field as the answer. Null is the API saying there is no one to
 * name, and such an actor is shown by id.
 */
export type ActorEmails = Map<string, string>;

/**
 * Who did it, in words, for a view about ONE end-user (their Overview and
 * Security tabs). Operators by email, which is what the operator asked for:
 * "which of us did this to my customer?" used to be answered "operator".
 *
 *   - the end-user themselves: "this user"
 *   - an operator: their email, or the id when it cannot be resolved
 *   - `system` acting with an API key (a backend granting credits): the key,
 *     by name and prefix, from the event's metadata
 *   - any other `system`: "system"
 *   - anything else (a type added later): the type, and the id if any
 */
export function actorLabel(
  e: { actorType: string; actorId: string | null; actorEmail: string | null; metadata?: unknown },
  subjectEndUserId: string,
): string {
  if (e.actorType === 'end_user') {
    return e.actorId === subjectEndUserId ? 'this user' : (e.actorEmail ?? e.actorId ?? 'an end-user');
  }
  if (e.actorType === 'operator') return e.actorEmail ?? (e.actorId ? `operator ${e.actorId}` : 'an operator');
  if (e.actorType === 'system') return apiKeyLabel(e.metadata) ?? 'system';
  return e.actorId ? `${e.actorType.replace('_', ' ')} ${e.actorId}` : e.actorType.replace('_', ' ');
}

/** "API key Backend (rk_live_ab12)" from an event's metadata, or null when it names no key. */
function apiKeyLabel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  const name = typeof m.apiKeyName === 'string' && m.apiKeyName !== '' ? m.apiKeyName : null;
  const prefix = typeof m.keyPrefix === 'string' && m.keyPrefix !== '' ? m.keyPrefix : null;
  if (name && prefix) return `API key ${name} (${prefix})`;
  if (name ?? prefix) return `API key ${name ?? prefix}`;
  return null;
}

/**
 * Readable one-liner from an event's `metadata`, for the end-user Security
 * tab's Detail column. The shape varies by type (`{via}` on sign-in,
 * `{reason}` where the API records one, `{deviceId}` and `{sessionsRevoked}`
 * on the device events, `{amount}` on a credit grant), so pick the keys worth
 * surfacing and fall back to a compact render of whatever is there.
 */
export function eventSummary(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parts: string[] = [];
  for (const key of [
    'via',
    'amount',
    'reason',
    'deviceName',
    'provider',
    'releasedBy',
    'sessionsRevoked',
    'count',
  ] as const) {
    const v = metadata[key];
    if (typeof v === 'string' && v !== '') parts.push(`${key}: ${v.replace(/_/g, ' ')}`);
    else if (typeof v === 'number') parts.push(`${key}: ${v}`);
  }
  if (parts.length > 0) return parts.join(' · ');
  const keys = Object.keys(metadata);
  return keys.length === 0 ? null : keys.slice(0, 3).join(', ');
}

/**
 * @example
 * const emails = actorEmailsOf(events); // Map { 'op_1' => 'ops@example.com' }
 */
export function actorEmailsOf(events: ReadonlyArray<{ actorId: string | null; actorEmail: string | null }>): ActorEmails {
  const out: ActorEmails = new Map();
  for (const e of events) {
    if (e.actorId !== null && e.actorEmail !== null) out.set(e.actorId, e.actorEmail);
  }
  return out;
}
