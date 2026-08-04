import * as React from 'react';
import { api, type EmailLogWithApp } from '@/lib/api';
import { EmailLogsTable, EmailLogStatusFilter } from '@/components/EmailLogsTable';
import { PageHeader } from '@/components/PageHeader';
import { Pager, readPageSize, readOffset } from '@/components/Pager';
import type { Page } from '@/lib/paginate';

const STATUSES = new Set(['sent', 'error', 'no_transport']);

export default async function WorkspaceEmailLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const status = typeof sp.status === 'string' && STATUSES.has(sp.status) ? sp.status : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = readOffset(sp);

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset) qs.set('offset', String(offset));
  if (status) qs.set('status', status);

  const { items: rows, page } = await api<Page<EmailLogWithApp>>({
    method: 'GET',
    path: `/api/v1/tenant/workspace/email-logs?${qs.toString()}`,
  });

  return (
    <section className="mx-auto max-w-7xl space-y-5 px-6 py-8 lg:px-8">
      <PageHeader
        title={
          <>
            System email logs{' '}
            <span className="text-base font-normal text-[var(--color-muted-fg)]">
              ({rows.length === 0 ? 0 : `${offset + 1}–${offset + rows.length}`})
            </span>
          </>
        }
        description="Workspace SYSTEM mail only — operator magic-link / password-reset and member invitations (sends not tied to an Application). Per-application email lives inside each Application → Email. Metadata only; bodies are never stored."
        action={<EmailLogStatusFilter basePath="/email-logs" active={status} pageSize={PAGE_SIZE} />}
      />

      <EmailLogsTable rows={rows} filtered={Boolean(status)} />
      <Pager
        basePath="/email-logs"
        offset={offset}
        pageSize={PAGE_SIZE}
        count={rows.length}
        hasMore={page.hasMore}
        extraParams={status ? { status } : undefined}
      />
    </section>
  );
}
