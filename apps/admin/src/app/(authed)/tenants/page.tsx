import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { SearchForm, buildQs } from '@/components/SearchForm';
import { Pagination } from '@/components/Pagination';
import { DateTime } from '@/components/DateTime';
import { CopyButton } from '@/components/CopyButton';
import { adminGetSafe, emptyPage, type Paginated, type TenantSummaryRow } from '@/lib/api';
import { fmtCount, fmtMoney } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
// Mirrors COMPUTED_SCAN_CAP in apps/api admin-metrics.service.ts. Computed
// sorts (MRR / counts / last-activity) are ranked over only the first N rows
// because each value is a per-row aggregate fan-out, not a DB column — a global
// ranking would fan out for every matching row on every load. Page nav for
// those sorts stops here; createdAt / name (real columns) page the full set.
const COMPUTED_SCAN_CAP = 500;
const COMPUTED_SORTS = new Set<SortField>(['mrrCents', 'endUserCount', 'applicationCount', 'lastActivityAt']);
type SortField = 'createdAt' | 'name' | 'mrrCents' | 'endUserCount' | 'applicationCount' | 'lastActivityAt';

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : undefined;
  const sort = (typeof params.sort === 'string' ? params.sort : 'mrrCents') as SortField;
  const order = (typeof params.order === 'string' ? params.order : 'desc') as 'asc' | 'desc';
  const page = Math.max(1, Number(params.page) || 1);

  const qs = buildQs({ q, sort, order, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const tenants =
    (await adminGetSafe<Paginated<TenantSummaryRow>>(`/api/v1/admin/metrics/tenants${qs}`)) ??
    emptyPage<TenantSummaryRow>(PAGE_SIZE);

  // Helper for building a sort-toggle link on a column header.
  function sortHref(field: SortField): string {
    const nextOrder: 'asc' | 'desc' = sort === field && order === 'desc' ? 'asc' : 'desc';
    return buildQs({ q, sort: field, order: nextOrder });
  }
  function sortIcon(field: SortField): string {
    if (sort !== field) return '';
    return order === 'desc' ? ' ▼' : ' ▲';
  }

  const rows = tenants.items;

  const columns: Column<TenantSummaryRow>[] = [
    {
      key: 'name',
      header: <a href={sortHref('name')} className="hover:text-[var(--color-fg)]">Tenant{sortIcon('name')}</a>,
      render: (t) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{t.name}</p>
          <p className="flex items-center gap-1 font-mono text-[11px] text-[var(--color-faint-fg)]">
            {t.id}
            <CopyButton value={t.id} />
          </p>
        </div>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (t) => <span className="text-[var(--color-muted-fg)]">{t.ownerEmail}</span>,
    },
    {
      key: 'apps',
      header: <a href={sortHref('applicationCount')} className="hover:text-[var(--color-fg)]">Apps{sortIcon('applicationCount')}</a>,
      align: 'right',
      render: (t) => fmtCount(t.applicationCount),
    },
    {
      key: 'users',
      header: <a href={sortHref('endUserCount')} className="hover:text-[var(--color-fg)]">End-users{sortIcon('endUserCount')}</a>,
      align: 'right',
      render: (t) => fmtCount(t.endUserCount),
    },
    { key: 'orgs', header: 'Orgs', align: 'right', render: (t) => fmtCount(t.organizationCount) },
    { key: 'subs', header: 'Active subs', align: 'right', render: (t) => fmtCount(t.activeSubscriptions) },
    {
      key: 'mrr',
      header: <a href={sortHref('mrrCents')} className="hover:text-[var(--color-fg)]">MRR{sortIcon('mrrCents')}</a>,
      align: 'right',
      render: (t) => (
        <span title={t.mrrCapped ? 'Lower bound — MRR read cap saturated' : undefined}>
          {fmtMoney(t.mrrCents)}
          {t.mrrCapped && <span className="ml-1 text-[var(--color-warning)]">≥</span>}
        </span>
      ),
    },
    {
      key: 'last',
      header: <a href={sortHref('lastActivityAt')} className="hover:text-[var(--color-fg)]">Last activity{sortIcon('lastActivityAt')}</a>,
      render: (t) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={t.lastActivityAt} /></span>,
    },
    {
      key: 'created',
      header: <a href={sortHref('createdAt')} className="hover:text-[var(--color-fg)]">Created{sortIcon('createdAt')}</a>,
      render: (t) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={t.createdAt} /></span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Tenants"
        description={`${fmtCount(tenants.total)} ${q ? 'matching' : 'tenants'} ordered by ${sort}.`}
        action={
          <SearchForm
            initialValue={q}
            placeholder="Search name / email / id"
            hidden={{ sort, order }}
          />
        }
      />
      <DataTable<TenantSummaryRow>
        rows={rows}
        columns={columns}
        getKey={(t) => t.id}
        emptyMessage={q ? `No tenants match "${q}".` : 'No tenants yet.'}
      />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={tenants.total}
        cap={COMPUTED_SORTS.has(sort) ? COMPUTED_SCAN_CAP : undefined}
        capReason={`Sorting by ${sort} ranks only the first ${COMPUTED_SCAN_CAP} tenants (it's a computed value, not a DB column). Sort by Created or Tenant name to page the full set.`}
        buildHref={(p) => buildQs({ q, sort, order, page: p })}
      />
    </>
  );
}
