import * as React from 'react';
import { redirect } from 'next/navigation';
import { formatDateTime } from '@/lib/date';
import { api, type SecurityEventRow } from '@/lib/api';
import { Pager, readPageSize, DEFAULT_PAGE_SIZE } from '@/components/Pager';
import { PageHeader } from '@/components/PageHeader';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD, readSort, sortToggleHref } from '@/components/Table';
import { EmptyState } from '@/components/EmptyState';
import { ActorCell } from '@/components/ActorCell';
import {
  eventTypeOptions,
  humanizeEventType,
  resolveActorEmails,
} from '@/lib/security-events';

const ACTOR_TYPES = ['operator', 'end_user', 'system'] as const;

const TYPE_OPTIONS = eventTypeOptions();

const inputCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

// Server action (rather than a plain GET form) so the Apply button gets a
// useFormStatus pending state while the filtered list re-renders. Mirrors the
// GET form's behavior exactly: only non-empty filter fields become query
// params; sort/page-size reset, same as a native form submit did.
async function applyFilters(formData: FormData): Promise<void> {
  'use server';
  const qs = new URLSearchParams();
  for (const key of ['type', 'actorType', 'from', 'to'] as const) {
    const v = String(formData.get(key) ?? '').trim();
    if (v) qs.set(key, v);
  }
  const s = qs.toString();
  redirect(s ? `/audit-log?${s}` : '/audit-log');
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const PAGE_SIZE = readPageSize(sp);

  // Accept ANY syntactically plausible type, not only the ones we have a label
  // for. The old `sp.type in TYPE_LABEL` guard silently discarded a hand-typed
  // `?type=app.plan_created` — the page rendered the unfiltered log with no
  // indication the filter had been thrown away. The API takes
  // `z.string().min(1).max(80)`, so mirror that and let it answer.
  const rawType = typeof sp.type === 'string' ? sp.type.trim() : '';
  const type = rawType.length > 0 && rawType.length <= 80 ? rawType : '';
  // A type outside our map is still a valid filter — surface it in the select
  // rather than resetting the control to "All types" while the filter is live.
  const typeOptions =
    type !== '' && !TYPE_OPTIONS.some((o) => o.value === type)
      ? [...TYPE_OPTIONS, { value: type, label: humanizeEventType(type) }]
      : TYPE_OPTIONS;
  const actorType =
    typeof sp.actorType === 'string' &&
    (ACTOR_TYPES as readonly string[]).includes(sp.actorType)
      ? sp.actorType
      : '';
  const from = typeof sp.from === 'string' && sp.from ? sp.from : ''; // yyyy-mm-dd
  const to = typeof sp.to === 'string' && sp.to ? sp.to : '';
  const filtered = Boolean(type || actorType || from || to);

  // Shared filter params for the list fetch AND the CSV export link. Date
  // inputs are day-granular; make the window inclusive of both ends.
  const filterQs = new URLSearchParams();
  if (type) filterQs.set('type', type);
  if (actorType) filterQs.set('actorType', actorType);
  if (from) filterQs.set('from', `${from}T00:00:00.000Z`);
  if (to) filterQs.set('to', `${to}T23:59:59.999Z`);

  const sorted = readSort(sp, ['createdAt', 'type'] as const);
  const qs = new URLSearchParams(filterQs);
  if (sorted) {
    qs.set('sort', sorted.sort);
    qs.set('order', sorted.order);
  }
  qs.set('limit', String(PAGE_SIZE));
  if (offset) qs.set('offset', String(offset));
  const { events } = await api<{ events: SecurityEventRow[] }>({
    method: 'GET',
    path: `/api/v1/tenant/security-events?${qs.toString()}`,
  });
  // Resolve actor CUIDs to emails for THIS page of rows. See lib/security-events.
  const actorEmails = await resolveActorEmails(events);

  const filterQsStr = filterQs.toString();
  const exportHref = `/audit-log/export${filterQsStr ? `?${filterQsStr}` : ''}`;
  const filterParams: Record<string, string> = {};
  if (type) filterParams.type = type;
  if (actorType) filterParams.actorType = actorType;
  if (from) filterParams.from = from;
  if (to) filterParams.to = to;
  // Pager links carry the active sort; sort links carry filters + page size
  // (offset resets when re-sorting).
  const extraParams: Record<string, string> = {
    ...filterParams,
    ...(sorted ? { sort: sorted.sort, order: sorted.order } : {}),
  };
  const sortTH = (column: 'createdAt' | 'type') =>
    sortToggleHref({
      basePath: '/audit-log',
      column,
      current: sorted,
      extraParams: {
        ...filterParams,
        ...(PAGE_SIZE !== DEFAULT_PAGE_SIZE ? { ps: String(PAGE_SIZE) } : {}),
      },
    });

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <PageHeader
        title="Audit log"
        description="Security-relevant events for this workspace — sign-ins, API-key lifecycle, session kill-switch, access-control changes. Newest first."
        action={
          <a
            href={exportHref}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] whitespace-nowrap"
            title="Download the filtered log as CSV (capped at 5000 rows, newest first)"
          >
            Export CSV
          </a>
        }
      />

      <form action={applyFilters} className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">Event type</span>
          <select name="type" defaultValue={type} className={inputCls}>
            <option value="">All types</option>
            {typeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">Actor</span>
          <select name="actorType" defaultValue={actorType} className={inputCls}>
            <option value="">All actors</option>
            {ACTOR_TYPES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">From</span>
          <input type="date" name="from" defaultValue={from} className={inputCls} />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">To</span>
          <input type="date" name="to" defaultValue={to} className={inputCls} />
        </label>
        <SubmitButton
          pendingLabel="Applying…"
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-muted)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Apply
        </SubmitButton>
        {filtered && (
          <a
            href="/audit-log"
            className="px-1 py-2 text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
          >
            filtered — clear
          </a>
        )}
      </form>

      {events.length === 0 ? (
        <EmptyState
          variant="inline"
          title={filtered ? 'No events match these filters' : 'No security events yet'}
          description={filtered ? 'Try widening the date range or clearing a filter.' : undefined}
        />
      ) : (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH sort={sortTH('type')}>Event</TH>
              <TH>Actor</TH>
              <TH>IP</TH>
              <TH sort={sortTH('createdAt')}>When</TH>
            </TR>
          </THead>
          <TBody>
            {events.map((e) => (
              <TR key={e.id} hover>
                <TD>
                  <div className="font-medium text-[var(--color-fg)]">{humanizeEventType(e.type)}</div>
                  <div className="font-mono text-xs text-[var(--color-muted-fg)]">{e.type}</div>
                </TD>
                <TD>
                  <ActorCell
                    actorType={e.actorType}
                    actorId={e.actorId}
                    applicationId={e.applicationId}
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
            ))}
          </TBody>
        </Table>
      )}

      <Pager
        basePath="/audit-log"
        offset={offset}
        pageSize={PAGE_SIZE}
        count={events.length}
        extraParams={Object.keys(extraParams).length ? extraParams : undefined}
      />
    </section>
  );
}
