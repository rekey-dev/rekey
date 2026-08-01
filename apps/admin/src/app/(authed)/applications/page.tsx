import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { SearchForm, buildQs } from '@/components/SearchForm';
import { Pagination } from '@/components/Pagination';
import { DateTime } from '@/components/DateTime';
import { CopyButton } from '@/components/CopyButton';
import { Badge, environmentTone } from '@/components/Badge';
import { adminGetSafe, emptyPage, type Paginated, type ApplicationSummaryRow } from '@/lib/api';
import { fmtCount } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
// See tenants/page.tsx — mirrors COMPUTED_SCAN_CAP in the API service. Computed
// sorts rank only the first N rows (per-row aggregate, not a DB column).
const COMPUTED_SCAN_CAP = 500;
const COMPUTED_SORTS = new Set<SortField>(['endUserCount', 'activeSubscriptions', 'apiRequestsLast24h']);
type SortField = 'createdAt' | 'name' | 'slug' | 'endUserCount' | 'activeSubscriptions' | 'apiRequestsLast24h';

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : undefined;
  const sort = (typeof params.sort === 'string' ? params.sort : 'apiRequestsLast24h') as SortField;
  const order = (typeof params.order === 'string' ? params.order : 'desc') as 'asc' | 'desc';
  const tenantId = typeof params.tenantId === 'string' ? params.tenantId : undefined;
  const page = Math.max(1, Number(params.page) || 1);

  const qs = buildQs({ q, sort, order, tenantId, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const apps =
    (await adminGetSafe<Paginated<ApplicationSummaryRow>>(`/api/v1/admin/metrics/applications${qs}`)) ??
    emptyPage<ApplicationSummaryRow>(PAGE_SIZE);

  function sortHref(field: SortField): string {
    const nextOrder: 'asc' | 'desc' = sort === field && order === 'desc' ? 'asc' : 'desc';
    return buildQs({ q, sort: field, order: nextOrder, tenantId });
  }
  function sortIcon(field: SortField): string {
    if (sort !== field) return '';
    return order === 'desc' ? ' ▼' : ' ▲';
  }

  const rows = apps.items;

  const columns: Column<ApplicationSummaryRow>[] = [
    {
      key: 'app',
      header: <a href={sortHref('name')} className="hover:text-[var(--color-fg)]">Application{sortIcon('name')}</a>,
      render: (a) => (
        <div className="min-w-0">
          <p className="flex items-center gap-2">
            {/* min-w-0 keeps the name truncating now that it's a flex item, and
                shrink-0 keeps the badge whole instead of squeezing it. */}
            <span className="min-w-0 truncate font-medium">{a.name}</span>
            <Badge tone={environmentTone(a.environment)} className="shrink-0">
              {a.environment}
            </Badge>
          </p>
          <p className="flex items-center gap-1 font-mono text-[11px] text-[var(--color-faint-fg)]">
            {a.slug}
            <CopyButton value={a.id} label={`Copy ${a.id}`} />
          </p>
        </div>
      ),
    },
    { key: 'tenant', header: 'Tenant', render: (a) => <span className="text-[var(--color-muted-fg)]">{a.tenantName}</span> },
    {
      key: 'users',
      header: <a href={sortHref('endUserCount')} className="hover:text-[var(--color-fg)]">End-users{sortIcon('endUserCount')}</a>,
      align: 'right',
      render: (a) => fmtCount(a.endUserCount),
    },
    {
      key: 'subs',
      header: <a href={sortHref('activeSubscriptions')} className="hover:text-[var(--color-fg)]">Active subs{sortIcon('activeSubscriptions')}</a>,
      align: 'right',
      render: (a) => fmtCount(a.activeSubscriptions),
    },
    {
      key: 'req',
      header: <a href={sortHref('apiRequestsLast24h')} className="hover:text-[var(--color-fg)]">Reqs 24h{sortIcon('apiRequestsLast24h')}</a>,
      align: 'right',
      render: (a) => fmtCount(a.apiRequestsLast24h),
    },
    {
      key: 'created',
      header: <a href={sortHref('createdAt')} className="hover:text-[var(--color-fg)]">Created{sortIcon('createdAt')}</a>,
      render: (a) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={a.createdAt} /></span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Applications"
        description={`${fmtCount(apps.total)} applications${tenantId ? ` for tenant ${tenantId}` : ''}.`}
        action={
          <SearchForm
            initialValue={q}
            placeholder="Search name / slug / id"
            hidden={{ sort, order, tenantId }}
          />
        }
      />
      <DataTable<ApplicationSummaryRow>
        rows={rows}
        columns={columns}
        getKey={(a) => a.id}
        emptyMessage={q ? `No applications match "${q}".` : 'No applications yet.'}
      />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={apps.total}
        cap={COMPUTED_SORTS.has(sort) ? COMPUTED_SCAN_CAP : undefined}
        capReason={`Sorting by ${sort} ranks only the first ${COMPUTED_SCAN_CAP} applications (it's a computed value, not a DB column). Sort by Created, name, or slug to page the full set.`}
        buildHref={(p) => buildQs({ q, sort, order, tenantId, page: p })}
      />
    </>
  );
}
