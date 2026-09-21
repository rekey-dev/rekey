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
const DETAIL_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'tool', label: 'tool' },
  { key: 'scope', label: 'scope' },
  { key: 'enabled', label: 'state' },
  { key: 'via', label: 'via' },
  { key: 'role', label: 'role' },
  { key: 'planSlug', label: 'plan' },
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
  for (const { key, label } of DETAIL_KEYS) {
    if (!(key in m)) continue;
    const v = m[key];
    let value: string | null = null;
    if (typeof v === 'string') value = v.replace(/_/g, ' ');
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
 * The API does not join this. `SecurityEvent` has no relations at all,
 * `actorId` is a bare scalar pointing at `TenantUser.id` or `EndUser.id`
 * depending on `actorType`, and the list endpoint has no `actorId` filter and
 * no email in its serializer. Payments and Dunning show an email because their
 * endpoints return `endUserEmail`; the audit log and Activity showed a raw CUID
 * because theirs doesn't.
 *
 * So the panel resolves it. Operators come from one workspace-members read
 * (small, already cached per request). End-users are fetched by id, deduped
 * and in parallel, capped at `MAX_END_USER_LOOKUPS`, a page is 50 rows and
 * distinct actors are far fewer, but the cap keeps a pathological page from
 * fanning out unboundedly. Anything unresolved falls back to the CUID, which
 * is strictly no worse than before.
 */
export type ActorEmails = Map<string, string>;

const MAX_END_USER_LOOKUPS = 40;

export async function resolveActorEmails(
  events: Array<{ actorType: string; actorId: string | null; applicationId: string | null }>,
): Promise<ActorEmails> {
  const out: ActorEmails = new Map();

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
