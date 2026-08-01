import * as React from 'react';
import { redirect } from 'next/navigation';
import { formatDateTime } from '@/lib/date';
import { api, type EndUserRow, type SecurityEventRow } from '@/lib/api';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { SubmitButton } from '@/components/SubmitButton';
import { ActorCell } from '@/components/ActorCell';
import { Pager, readOffset, readPageSize } from '@/components/Pager';
import { humanizeEventType, resolveActorEmails } from '@/lib/security-events';

/**
 * Per-application Activity log. End-user-scoped events (sign-ups, sign-ins,
 * password/passkey/email changes) recorded in the API auth routes and read back
 * filtered to `actorType=end_user` for this application.
 *
 * ## Filtering by email
 *
 * `GET /tenant/security-events` accepts `applicationId`, `type`, `actorType`,
 * `from`, `to`, `limit`, `offset` — and no way to narrow to a person. There is
 * no `actorId` filter and no email in the response. So the panel does it: it
 * resolves the address to an end-user id via the end-users search, pulls the
 * largest window the API allows (200), and filters in memory. That is a real
 * scan limit and the UI says so rather than implying an exhaustive search.
 *
 * ## What is NOT here
 *
 * FAILED sign-ins. The API does not record them as security events at all —
 * `auth.service.ts` increments a Redis brute-force counter and throws 401, with
 * no `recordSecurityEvent` on that path; lockout does the same. There is no
 * event type for either, so no amount of panel work can list them. The banner
 * below states that plainly instead of leaving an operator to conclude a user
 * with 7 failed attempts simply did nothing.
 */

function viaLabel(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && 'via' in metadata) {
    const via = (metadata as { via?: unknown }).via;
    if (typeof via === 'string') return via.replace(/_/g, ' ');
  }
  return null;
}

const inputCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

/** Scan window when filtering by email — the API's `limit` ceiling. */
const SCAN_LIMIT = 200;

async function applyFilters(appId: string, formData: FormData): Promise<void> {
  'use server';
  const qs = new URLSearchParams();
  const email = String(formData.get('email') ?? '').trim();
  if (email) qs.set('email', email);
  const s = qs.toString();
  redirect(s ? `/applications/${appId}/activity?${s}` : `/applications/${appId}/activity`);
}

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const offset = readOffset(sp);
  const PAGE_SIZE = readPageSize(sp);
  const email = typeof sp.email === 'string' ? sp.email.trim() : '';

  // Resolve the address to an end-user id first — that's what events carry.
  let filterActorId: string | null = null;
  let emailNotFound = false;
  if (email !== '') {
    const found = await api<EndUserRow[] | { endUsers: EndUserRow[] }>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users?search=${encodeURIComponent(email)}&limit=10`,
    }).catch(() => null);
    const rows = found === null ? [] : Array.isArray(found) ? found : (found.endUsers ?? []);
    const exact = rows.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? rows[0];
    if (exact === undefined) emailNotFound = true;
    else filterActorId = exact.id;
  }

  const qs = new URLSearchParams({
    applicationId: id,
    actorType: 'end_user',
    // Filtering by person has to over-fetch and narrow in memory (see above).
    limit: String(filterActorId !== null ? SCAN_LIMIT : PAGE_SIZE),
  });
  if (offset && filterActorId === null) qs.set('offset', String(offset));

  const { events: fetched } = await api<{ events: SecurityEventRow[] }>({
    method: 'GET',
    path: `/api/v1/tenant/security-events?${qs.toString()}`,
  });

  const matched = filterActorId === null ? fetched : fetched.filter((e) => e.actorId === filterActorId);
  const events = filterActorId === null ? matched : matched.slice(offset, offset + PAGE_SIZE);
  // The scan hit its ceiling, so "no more results" isn't provable.
  const scanTruncated = filterActorId !== null && fetched.length >= SCAN_LIMIT;

  const actorEmails = await resolveActorEmails(events);
  const extraParams = email ? { email } : undefined;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Activity"
        description="End-user events for this application — sign-ups, sign-ins, and credential changes. Newest first."
      />

      <form action={applyFilters.bind(null, id)} className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">End-user email</span>
          <input
            type="search"
            name="email"
            defaultValue={email}
            placeholder="ada@example.com"
            className={`${inputCls} min-w-[16rem]`}
          />
        </label>
        <SubmitButton
          pendingLabel="Filtering…"
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-muted)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Filter
        </SubmitButton>
        {email !== '' && (
          <a
            href={`/applications/${id}/activity`}
            className="px-1 py-2 text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
          >
            filtered — clear
          </a>
        )}
      </form>

      {/* Not a caveat we can design away: the events simply do not exist. */}
      <Banner tone="info">
        Failed sign-ins and lockouts are <strong>not</strong> recorded as events — the API counts
        them in Redis and discards the detail, so they can&apos;t be listed here or anywhere else.
        The live counter and lock state for one person are on their end-user page.
      </Banner>

      {emailNotFound && (
        <Banner tone="warning">
          No end-user in this application matches <strong>{email}</strong>.
        </Banner>
      )}

      {scanTruncated && (
        <Banner tone="warning">
          Searched the most recent {SCAN_LIMIT} events for this application. Older activity for this
          person isn&apos;t included — the API can filter events by application and actor type, but
          not by person.
        </Banner>
      )}

      {events.length === 0 ? (
        <EmptyState
          variant="inline"
          title={email !== '' ? 'No activity for this end-user' : 'No end-user activity yet'}
          description={
            email !== ''
              ? 'Nothing in the scanned window. Successful sign-ins and credential changes appear here; failed attempts are never recorded.'
              : 'Events appear here as your users sign up and sign in.'
          }
        />
      ) : (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Event</TH>
              <TH>End-user</TH>
              <TH>IP</TH>
              <TH>When</TH>
            </TR>
          </THead>
          <TBody>
            {events.map((e) => {
              const via = viaLabel(e.metadata);
              return (
                <TR key={e.id} hover>
                  <TD>
                    <div className="flex items-center gap-2 font-medium text-[var(--color-fg)]">
                      {humanizeEventType(e.type)}
                      {via && (
                        <Badge tone="neutral" className="font-normal">
                          {via}
                        </Badge>
                      )}
                    </div>
                    <div className="font-mono text-xs text-[var(--color-muted-fg)]">{e.type}</div>
                  </TD>
                  <TD className="text-xs">
                    <ActorCell
                      actorType={e.actorType}
                      actorId={e.actorId}
                      applicationId={e.applicationId ?? id}
                      emails={actorEmails}
                    />
                  </TD>
                  <TD mono muted>
                    {e.ip ?? '—'}
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(e.createdAt)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      <Pager
        basePath={`/applications/${id}/activity`}
        offset={offset}
        pageSize={PAGE_SIZE}
        count={events.length}
        extraParams={extraParams}
      />
    </div>
  );
}
