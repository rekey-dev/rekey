import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge } from '@/components/Badge';
import { SearchForm, FilterChips, buildQs } from '@/components/SearchForm';
import { Pagination } from '@/components/Pagination';
import { DateTime } from '@/components/DateTime';
import { CopyButton } from '@/components/CopyButton';
import { adminGetSafe, emptyPage, type Paginated, type RequestLogRow } from '@/lib/api';
import { fmtCount, fmtDuration } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

// Click a chip → set statusGte+statusLt for that family. Encoded into a
// single `statusFamily` param so the URL stays readable.
const STATUS_FAMILIES = [
  { value: '2xx', label: '2xx' },
  { value: '3xx', label: '3xx' },
  { value: '4xx', label: '4xx' },
  { value: '5xx', label: '5xx' },
];
function familyRange(family: string | undefined): { gte?: number; lt?: number } {
  switch (family) {
    case '2xx': return { gte: 200, lt: 300 };
    case '3xx': return { gte: 300, lt: 400 };
    case '4xx': return { gte: 400, lt: 500 };
    case '5xx': return { gte: 500, lt: 600 };
    default: return {};
  }
}

const METHODS = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'DELETE', label: 'DELETE' },
];

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const pathContains = typeof params.pathContains === 'string' ? params.pathContains : undefined;
  const method = typeof params.method === 'string' ? params.method : undefined;
  const statusFamily = typeof params.statusFamily === 'string' ? params.statusFamily : undefined;
  const sort = (typeof params.sort === 'string' ? params.sort : 'createdAt') as 'createdAt' | 'durationMs' | 'statusCode';
  const order = (typeof params.order === 'string' ? params.order : 'desc') as 'asc' | 'desc';
  const page = Math.max(1, Number(params.page) || 1);

  const { gte, lt } = familyRange(statusFamily);
  const qs = buildQs({ pathContains, method, statusGte: gte, statusLt: lt, sort, order, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const result =
    (await adminGetSafe<Paginated<RequestLogRow>>(`/api/v1/admin/metrics/api-requests${qs}`)) ??
    emptyPage<RequestLogRow>(PAGE_SIZE);
  const rows = result.items;

  function sortHref(field: 'createdAt' | 'durationMs' | 'statusCode'): string {
    const nextOrder: 'asc' | 'desc' = sort === field && order === 'desc' ? 'asc' : 'desc';
    return buildQs({ pathContains, method, statusFamily, sort: field, order: nextOrder });
  }
  function sortIcon(field: string): string {
    if (sort !== field) return '';
    return order === 'desc' ? ' ▼' : ' ▲';
  }

  const columns: Column<RequestLogRow>[] = [
    {
      key: 'status',
      header: <a href={sortHref('statusCode')} className="hover:text-[var(--color-fg)]">Status{sortIcon('statusCode')}</a>,
      render: (r) => (
        <Badge tone={r.statusCode >= 500 ? 'danger' : r.statusCode >= 400 ? 'warning' : 'positive'}>{r.statusCode}</Badge>
      ),
    },
    { key: 'method', header: 'Method', render: (r) => <span className="font-mono text-xs">{r.method}</span> },
    { key: 'path', header: 'Path', render: (r) => <span className="font-mono text-xs">{r.routePath}</span> },
    {
      key: 'duration',
      header: <a href={sortHref('durationMs')} className="hover:text-[var(--color-fg)]">Duration{sortIcon('durationMs')}</a>,
      align: 'right',
      render: (r) => fmtDuration(r.durationMs),
    },
    { key: 'app', header: 'App', render: (r) => r.applicationId ? (
      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-muted-fg)]">
        {r.applicationId}
        <CopyButton value={r.applicationId} />
      </span>
    ) : <span className="text-[var(--color-muted-fg)]">—</span> },
    { key: 'op', header: 'Operator', render: (r) => r.operatorUserId ? (
      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-muted-fg)]">
        {r.operatorUserId}
        <CopyButton value={r.operatorUserId} />
      </span>
    ) : <span className="text-[var(--color-muted-fg)]">—</span> },
    { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-xs">{r.ip ?? '—'}</span> },
    {
      key: 'created',
      header: <a href={sortHref('createdAt')} className="hover:text-[var(--color-fg)]">When{sortIcon('createdAt')}</a>,
      render: (r) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={r.createdAt} /></span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="API requests"
        description={`${fmtCount(result.total)} matching requests. The table is a bounded tail; structured stdout is the authoritative log.`}
        action={
          <SearchForm
            initialValue={pathContains}
            name="pathContains"
            placeholder="Path contains…"
            hidden={{ method, statusFamily, sort, order }}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-4">
        <FilterChips
          label="Status"
          options={STATUS_FAMILIES}
          active={statusFamily}
          buildHref={(v) => buildQs({ pathContains, method, statusFamily: v, sort, order })}
        />
        <FilterChips
          label="Method"
          options={METHODS}
          active={method}
          buildHref={(v) => buildQs({ pathContains, method: v, statusFamily, sort, order })}
        />
      </div>
      <DataTable<RequestLogRow>
        rows={rows}
        columns={columns}
        getKey={(r) => r.id}
        emptyMessage="No requests match these filters."
      />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total}
        buildHref={(p) => buildQs({ pathContains, method, statusFamily, sort, order, page: p })}
      />
    </>
  );
}
