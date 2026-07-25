import * as React from 'react';
import Link from 'next/link';
import { api, type EmailLogRow, type EmailLogWithApp } from '@/lib/api';
import { EmailLogsTable, EmailLogStatusFilter } from '@/components/EmailLogsTable';
import { Pager, readPageSize, readOffset } from '@/components/Pager';

const STATUSES = new Set(['sent', 'error', 'no_transport']);

export default async function ApplicationEmailLogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const status = typeof sp.status === 'string' && STATUSES.has(sp.status) ? sp.status : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = readOffset(sp);

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset) qs.set('offset', String(offset));
  if (status) qs.set('status', status);

  const rows = await api<EmailLogRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-logs?${qs.toString()}`,
  });

  // Per-app view: no app column. Widen to the shared row shape.
  const tableRows: EmailLogWithApp[] = rows.map((r) => ({ ...r, application: null }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={`/applications/${id}/email`}
            className="text-xs text-neutral-600 dark:text-neutral-500 hover:text-[var(--color-fg)]"
          >
            ← Email settings
          </Link>
          <h2 className="text-base font-medium mt-0.5">
            Send logs{' '}
            <span className="text-[var(--color-muted-fg)] text-sm font-normal">
              ({rows.length === 0 ? 0 : `${offset + 1}–${offset + rows.length}`})
            </span>
          </h2>
          <p className="text-sm text-[var(--color-muted-fg)] mt-1 max-w-2xl">
            Every transactional email this application attempted — verification, password reset,
            magic links, etc. Metadata only (recipient, subject, transport, status); message bodies
            are never stored.
          </p>
        </div>
        <EmailLogStatusFilter basePath={`/applications/${id}/email/logs`} active={status} pageSize={PAGE_SIZE} />
      </div>

      <EmailLogsTable rows={tableRows} filtered={Boolean(status)} />
      <Pager
        basePath={`/applications/${id}/email/logs`}
        offset={offset}
        pageSize={PAGE_SIZE}
        count={rows.length}
        extraParams={status ? { status } : undefined}
      />
    </div>
  );
}
