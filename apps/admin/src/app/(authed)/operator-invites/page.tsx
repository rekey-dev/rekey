import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, statusTone } from '@/components/Badge';
import { Pagination } from '@/components/Pagination';
import { buildQs } from '@/components/SearchForm';
import { DateTime } from '@/components/DateTime';
import { CopyButton } from '@/components/CopyButton';
import { adminGetSafe, type Paginated, type OperatorInviteRow } from '@/lib/api';
import { MintInviteForm } from './MintInviteForm';
import { revokeInvite } from './actions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type ModeCopy = { label: string; tone: 'positive' | 'warning' | 'default'; help: string };

const MODE_COPY: Record<string, ModeCopy> = {
  invite: {
    label: 'invite-only',
    tone: 'positive',
    help: 'New operators must present a single-use key from this page to sign up.',
  },
  closed: {
    label: 'closed',
    tone: 'warning',
    help: 'New operator registration is disabled. Keys here will not be redeemable until the mode is set to invite.',
  },
  open: {
    label: 'open',
    tone: 'default',
    help: 'Sign-up is open to anyone — invite keys are not required and are NOT consumed (a key passed during open mode stays active). Set OPERATOR_SIGNUP_MODE=invite to enforce them.',
  },
};

export default async function OperatorInvitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const qs = buildQs({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

  const [invites, modeRes] = await Promise.all([
    adminGetSafe<Paginated<OperatorInviteRow>>(`/api/v1/admin/operator-invites${qs}`),
    adminGetSafe<{ mode: string }>('/api/v1/tenant/auth/signup-mode'),
  ]);

  const mode = modeRes?.mode ?? 'open';
  const modeCopy: ModeCopy = MODE_COPY[mode] ?? MODE_COPY.open!;

  const columns: Column<OperatorInviteRow>[] = [
    {
      key: 'prefix',
      header: 'Key',
      render: (i) => (
        <span className="inline-flex items-center gap-1 font-mono text-[11px]">
          {i.tokenPrefix}…
          <CopyButton value={i.tokenPrefix} label="Copy prefix" />
        </span>
      ),
    },
    { key: 'note', header: 'Note', render: (i) => i.note ?? <span className="text-[var(--color-faint-fg)]">—</span> },
    { key: 'status', header: 'Status', render: (i) => <Badge tone={statusTone(i.status)}>{i.status}</Badge> },
    {
      key: 'used',
      header: 'Used by',
      render: (i) =>
        i.usedByTenantUserId ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-muted-fg)]">
            {i.usedByTenantUserId}
            <CopyButton value={i.usedByTenantUserId} />
          </span>
        ) : (
          <span className="text-[var(--color-faint-fg)]">—</span>
        ),
    },
    {
      key: 'expires',
      header: 'Expires',
      render: (i) =>
        i.expiresAt ? (
          <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={i.expiresAt} /></span>
        ) : (
          <span className="text-[var(--color-faint-fg)]">never</span>
        ),
    },
    { key: 'created', header: 'Created', render: (i) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={i.createdAt} /></span> },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (i) =>
        i.status === 'active' ? (
          <form action={revokeInvite}>
            <input type="hidden" name="id" value={i.id} />
            <button
              type="submit"
              className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
            >
              Revoke
            </button>
          </form>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Operator invites"
        description="Single-use keys that authorize a new operator + workspace when sign-up is invite-only."
        action={<Badge tone={modeCopy.tone}>mode: {modeCopy.label}</Badge>}
      />

      <Card>
        <p className="text-sm text-[var(--color-muted-fg)]">{modeCopy.help}</p>
      </Card>

      <section className="space-y-3">
        <SectionHeader title="Mint a key" />
        <Card>
          <MintInviteForm />
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeader title="Keys" count={invites ? `(${invites.total})` : ''} />
        {!invites ? (
          <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not load invite keys.</p></Card>
        ) : (
          <>
            <DataTable<OperatorInviteRow>
              rows={invites.items}
              columns={columns}
              getKey={(i) => i.id}
              emptyMessage="No invite keys yet. Mint one above."
            />
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={invites.total}
              buildHref={(p) => buildQs({ page: p })}
            />
          </>
        )}
      </section>
    </>
  );
}
