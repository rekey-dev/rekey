import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge } from '@/components/Badge';
import { SearchForm, FilterChips, buildQs } from '@/components/SearchForm';
import { Pagination } from '@/components/Pagination';
import { DateTime } from '@/components/DateTime';
import { CopyButton } from '@/components/CopyButton';
import { adminGetSafe, emptyPage, type Paginated, type SecurityEventRow } from '@/lib/api';
import { fmtCount } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const ACTOR_TYPES = [
  { value: 'operator', label: 'Operator' },
  { value: 'end_user', label: 'End-user' },
  { value: 'system', label: 'System' },
];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : undefined;
  const actorType = typeof params.actorType === 'string' ? params.actorType : undefined;
  const type = typeof params.type === 'string' ? params.type : undefined;
  const ip = typeof params.ip === 'string' ? params.ip : undefined;
  const page = Math.max(1, Number(params.page) || 1);

  const qs = buildQs({ q, actorType, type, ip, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const result =
    (await adminGetSafe<Paginated<SecurityEventRow>>(`/api/v1/admin/metrics/security-events${qs}`)) ??
    emptyPage<SecurityEventRow>(PAGE_SIZE);
  const events = result.items;

  const columns: Column<SecurityEventRow>[] = [
    { key: 'type', header: 'Type', render: (e) => <span className="font-mono text-xs">{e.type}</span> },
    {
      key: 'actor',
      header: 'Actor',
      render: (e) => (
        <div>
          <Badge>{e.actorType}</Badge>
          {e.actorId && (
            <p className="mt-1 flex items-center gap-1 font-mono text-[11px] text-[var(--color-muted-fg)]">
              {e.actorId.slice(0, 16)}…
              <CopyButton value={e.actorId} label={`Copy ${e.actorId}`} />
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'tenant',
      header: 'Tenant',
      // Resolved to a name server-side (securityEvents()); the raw cuid stays
      // available via the copy button for cross-referencing.
      render: (e) =>
        e.tenantId ? (
          <div>
            <p className="truncate text-xs">{e.tenantName ?? '(unknown)'}</p>
            <p className="flex items-center gap-1 font-mono text-[10px] text-[var(--color-faint-fg)]">
              {e.tenantId.slice(0, 12)}…
              <CopyButton value={e.tenantId} label={`Copy ${e.tenantId}`} />
            </p>
          </div>
        ) : (
          <span className="text-[var(--color-muted-fg)]">—</span>
        ),
    },
    {
      key: 'app',
      header: 'App',
      render: (e) =>
        e.applicationId ? (
          <div>
            <p className="truncate text-xs">
              {e.applicationName ?? '(unknown)'}
              {e.applicationSlug && <span className="text-[var(--color-faint-fg)]"> ({e.applicationSlug})</span>}
            </p>
            <p className="flex items-center gap-1 font-mono text-[10px] text-[var(--color-faint-fg)]">
              {e.applicationId.slice(0, 12)}…
              <CopyButton value={e.applicationId} label={`Copy ${e.applicationId}`} />
            </p>
          </div>
        ) : (
          <span className="text-[var(--color-muted-fg)]">—</span>
        ),
    },
    { key: 'ip', header: 'IP', render: (e) => <span className="font-mono text-xs">{e.ip ?? '—'}</span> },
    { key: 'ua', header: 'UA', render: (e) => <span className="text-xs text-[var(--color-muted-fg)] truncate inline-block max-w-[16ch]" title={e.userAgent ?? ''}>{e.userAgent ?? '—'}</span> },
    { key: 'created', header: 'When', render: (e) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={e.createdAt} /></span> },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description={`${fmtCount(result.total)} matching security events.`}
        action={
          <SearchForm
            initialValue={q}
            placeholder="id / actor-id / type substring"
            hidden={{ actorType, type, ip }}
          />
        }
      />
      <FilterChips
        label="Actor"
        options={ACTOR_TYPES}
        active={actorType}
        buildHref={(v) => buildQs({ q, actorType: v, type, ip })}
      />
      <DataTable<SecurityEventRow>
        rows={events}
        columns={columns}
        getKey={(e) => e.id}
        emptyMessage={q || actorType ? 'No events match these filters.' : 'No security events yet.'}
      />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total}
        buildHref={(p) => buildQs({ q, actorType, type, ip, page: p })}
      />
    </>
  );
}
