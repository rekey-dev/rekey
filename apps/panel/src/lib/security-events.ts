/**
 * Security-event presentation: labels for the log, and CUID→email resolution.
 *
 * The label map used to live here as a panel-side MIRROR of a list nobody
 * owned — the API emits its event types as bare string literals at ~62 call
 * sites — and this file said so, with "it should live in
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
// Actor resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map of `actorId` → email, for the actors on one page of events.
 *
 * The API does not join this. `SecurityEvent` has no relations at all —
 * `actorId` is a bare scalar pointing at `TenantUser.id` or `EndUser.id`
 * depending on `actorType`, and the list endpoint has no `actorId` filter and
 * no email in its serializer. Payments and Dunning show an email because their
 * endpoints return `endUserEmail`; the audit log and Activity showed a raw CUID
 * because theirs doesn't.
 *
 * So the panel resolves it. Operators come from one workspace-members read
 * (small, already cached per request). End-users are fetched by id, deduped
 * and in parallel, capped at `MAX_END_USER_LOOKUPS` — a page is 50 rows and
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
  // (applicationId, endUserId) pairs — an end-user id is only meaningful
  // within its application.
  const endUserKeys = new Map<string, { appId: string; euid: string }>();
  for (const e of events) {
    if (e.actorType !== 'end_user' || !e.actorId || !e.applicationId) continue;
    endUserKeys.set(e.actorId, { appId: e.applicationId, euid: e.actorId });
  }

  const lookups = [...endUserKeys.values()].slice(0, MAX_END_USER_LOOKUPS);

  // ONE wave, not two. The members read used to sit in its own `Promise.all`
  // — a `Promise.all` over a single element, which buys nothing but does cost
  // a whole serial round-trip: the end-user fan-out could not start until it
  // resolved. Neither depends on the other, so they go together and the audit
  // log loses a full API latency from every render.
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
