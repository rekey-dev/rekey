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
 * What stays here is the part that genuinely is panel-specific:
 * `resolveActorEmails`, which turns the API's bare `actorId` CUIDs into
 * addresses using panel-side API calls.
 */

export {
  SECURITY_EVENT_LABEL as EVENT_TYPE_LABEL,
  humanizeSecurityEventType as humanizeEventType,
  securityEventTypeOptions as eventTypeOptions,
  type SecurityEventType,
} from '@rekey.dev/shared-types';

import { apiGet, type EndUserRow, type MemberRow } from '@/lib/api';
import type { Page } from '@/lib/paginate';

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
 * takes that field as the answer.
 *
 * The lookups below are only for an event WITHOUT the field, which is an API
 * older than this panel during a rolling deploy: operators from one
 * workspace-members read, end-users fetched by id, deduped, in parallel and
 * capped at `MAX_END_USER_LOOKUPS`. Anything unresolved falls back to the CUID.
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
  e: { actorType: string; actorId: string | null; actorEmail?: string | null; metadata?: unknown },
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

const MAX_END_USER_LOOKUPS = 40;

export async function resolveActorEmails(
  allEvents: Array<{
    actorType: string;
    actorId: string | null;
    actorEmail?: string | null;
    applicationId: string | null;
  }>,
): Promise<ActorEmails> {
  const out: ActorEmails = new Map();
  for (const e of allEvents) {
    if (e.actorId && typeof e.actorEmail === 'string') out.set(e.actorId, e.actorEmail);
  }
  // Only what the API did not answer: `actorEmail` missing entirely, not null
  // (null is the API saying there is no one to name).
  const events = allEvents.filter((e) => e.actorEmail === undefined);

  const operatorIds = new Set(
    events.filter((e) => e.actorType === 'operator' && e.actorId).map((e) => e.actorId!),
  );
  // (applicationId, endUserId) pairs, an end-user id is only meaningful
  // within its application.
  const endUserKeys = new Map<string, { appId: string; euid: string }>();
  for (const e of events) {
    if (e.actorType !== 'end_user' || !e.actorId || !e.applicationId) continue;
    endUserKeys.set(e.actorId, { appId: e.applicationId, euid: e.actorId });
  }

  const lookups = [...endUserKeys.values()].slice(0, MAX_END_USER_LOOKUPS);

  // ONE wave, not two. The members read used to sit in its own `Promise.all`
  // over a single element, which buys nothing but does cost a whole serial
  // round-trip: the end-user fan-out could not start until it resolved.
  // Neither depends on the other, so they go together and the audit log no
  // longer loses a full API latency on every render.
  const [memberPage, resolved] = await Promise.all([
    operatorIds.size > 0
      ? apiGet<Page<MemberRow>>('/api/v1/tenant/workspace/members').catch(() => null)
      : Promise.resolve(null),
    Promise.all(
      lookups.map(async ({ appId, euid }) => {
        const detail = await apiGet<{ endUser: EndUserRow }>(
          `/api/v1/tenant/applications/${encodeURIComponent(appId)}/end-users/${encodeURIComponent(euid)}`,
          // A deleted end-user still has events; a 404 here must not 404 the
          // whole audit-log page.
          { interruptOnAccessError: false },
        ).catch(() => null);
        return detail === null ? null : ([euid, detail.endUser.email] as const);
      }),
    ),
  ]);

  for (const m of memberPage?.items ?? []) {
    if (operatorIds.has(m.tenantUserId)) out.set(m.tenantUserId, m.email);
  }
  for (const r of resolved) if (r !== null) out.set(r[0], r[1]);

  return out;
}
