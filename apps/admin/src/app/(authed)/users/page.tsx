import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge } from '@/components/Badge';
import { SearchForm, buildQs } from '@/components/SearchForm';
import { Pagination } from '@/components/Pagination';
import { DateTime } from '@/components/DateTime';
import { CopyButton } from '@/components/CopyButton';
import { adminGetSafe, type Paginated, type EndUserRow, type TenantUserRow, type LockedAccounts } from '@/lib/api';
import { fmtCount, fmtRelative } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : undefined;
  const applicationId = typeof params.applicationId === 'string' ? params.applicationId : undefined;
  // Two independent tables on one page → one page param each.
  const euPage = Math.max(1, Number(params.euPage) || 1);
  const opPage = Math.max(1, Number(params.opPage) || 1);

  const euQs = buildQs({ q, applicationId, limit: PAGE_SIZE, offset: (euPage - 1) * PAGE_SIZE });
  const opQs = buildQs({ q, applicationId, limit: PAGE_SIZE, offset: (opPage - 1) * PAGE_SIZE });

  const [endUsers, operators, locked] = await Promise.all([
    adminGetSafe<Paginated<EndUserRow>>(`/api/v1/admin/metrics/end-users${euQs}`),
    adminGetSafe<Paginated<TenantUserRow>>(`/api/v1/admin/metrics/tenant-users${opQs}`),
    adminGetSafe<LockedAccounts>('/api/v1/admin/metrics/locked-accounts?limit=20'),
  ]);

  const endUserColumns: Column<EndUserRow>[] = [
    {
      key: 'email',
      header: 'Email',
      render: (u) => (
        <div>
          <p className="truncate">{u.email}</p>
          <p className="flex items-center gap-1 font-mono text-[11px] text-[var(--color-faint-fg)]">
            {u.id}
            <CopyButton value={u.id} />
          </p>
        </div>
      ),
    },
    {
      key: 'app',
      header: 'Application',
      render: (u) => <span className="text-[var(--color-muted-fg)]">{u.applicationName} ({u.applicationSlug})</span>,
    },
    {
      key: 'role',
      header: 'Role',
      render: (u) => <Badge tone="default">{u.role}</Badge>,
    },
    {
      key: 'verified',
      header: 'Verified',
      render: (u) => u.emailVerified ? <Badge tone="positive">yes</Badge> : <Badge tone="warning">no</Badge>,
    },
    { key: 'last', header: 'Last seen', render: (u) => <span className="text-xs text-[var(--color-muted-fg)]">{fmtRelative(u.lastSeenAt)}</span> },
    { key: 'created', header: 'Created', render: (u) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={u.createdAt} /></span> },
  ];

  const operatorColumns: Column<TenantUserRow>[] = [
    {
      key: 'email',
      header: 'Operator',
      render: (o) => (
        <div>
          <p className="truncate">{o.email}</p>
          {o.name && <p className="text-xs text-[var(--color-muted-fg)]">{o.name}</p>}
        </div>
      ),
    },
    { key: 'workspaces', header: 'Workspaces', align: 'right', render: (o) => fmtCount(o.membershipCount) },
    {
      key: 'verified',
      header: 'Verified',
      render: (o) => o.emailVerified ? <Badge tone="positive">yes</Badge> : <Badge tone="warning">no</Badge>,
    },
    { key: 'last', header: 'Last seen', render: (o) => <span className="text-xs text-[var(--color-muted-fg)]">{fmtRelative(o.lastSeenAt)}</span> },
    { key: 'created', header: 'Created', render: (o) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={o.createdAt} /></span> },
  ];

  return (
    <>
      <PageHeader
        title="End-users & operators"
        description="Search applies to both tables. Last seen = most recent refresh-token issuance."
        action={
          <SearchForm
            initialValue={q}
            placeholder="Search email / name / id"
            hidden={{ applicationId }}
          />
        }
      />

      {locked && locked.total > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Locked accounts"
            count={`(${fmtCount(locked.total)})`}
            description="End-users currently inside the failed-sign-in lockout window. Auto-clears when `lockedUntil` passes; investigate if the same account locks repeatedly."
          />
          <DataTable<typeof locked.accounts[number]>
            rows={locked.accounts}
            columns={[
              { key: 'email', header: 'Email', render: (a) => <span className="font-mono text-xs">{a.email}</span> },
              { key: 'app', header: 'App', render: (a) => <span className="font-mono text-[11px]">{a.applicationSlug}</span> },
              { key: 'attempts', header: 'Failed', align: 'right', render: (a) => fmtCount(a.failedAttempts) },
              { key: 'until', header: 'Locked until', render: (a) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={a.lockedUntil} /></span> },
              { key: 'id', header: 'User id', render: (a) => (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-muted-fg)]">
                  {a.id}
                  <CopyButton value={a.id} />
                </span>
              ) },
            ]}
            getKey={(a) => a.id}
            emptyMessage="No accounts in lockout."
            footerNote={locked.total > locked.accounts.length ? `Showing ${locked.accounts.length} of ${fmtCount(locked.total)} locked.` : undefined}
          />
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader title="End-users" count={endUsers ? `(${fmtCount(endUsers.total)})` : ''} />
        {!endUsers ? (
          <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not load end-users.</p></Card>
        ) : (
          <>
            <DataTable<EndUserRow>
              rows={endUsers.items}
              columns={endUserColumns}
              getKey={(u) => u.id}
              emptyMessage={q ? `No end-users match "${q}".` : 'No end-users yet.'}
            />
            <Pagination
              page={euPage}
              pageSize={PAGE_SIZE}
              total={endUsers.total}
              buildHref={(p) => buildQs({ q, applicationId, euPage: p, opPage })}
            />
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Operators" count={operators ? `(${fmtCount(operators.total)})` : ''} />
        {!operators ? (
          <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not load operators.</p></Card>
        ) : (
          <>
            <DataTable<TenantUserRow>
              rows={operators.items}
              columns={operatorColumns}
              getKey={(o) => o.id}
              emptyMessage={q ? `No operators match "${q}".` : 'No operators yet.'}
            />
            <Pagination
              page={opPage}
              pageSize={PAGE_SIZE}
              total={operators.total}
              buildHref={(p) => buildQs({ q, applicationId, euPage, opPage: p })}
            />
          </>
        )}
      </section>
    </>
  );
}
