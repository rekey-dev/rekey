import * as React from 'react';
import { api, type ApiRequestLogRow } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { RequestLogTable } from '@/components/RequestLogTable';
import { Pager, readPageSize } from '@/components/Pager';

/**
 * Operator "My requests" — the calling operator's own requests to the tenant
 * API. The panel makes these on the operator's behalf (every page load fans
 * out to a few reads), so this is an honest record of API activity for the
 * account. Captured best-effort, capped per operator by a periodic pruner.
 */

export default async function AccountActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const PAGE_SIZE = readPageSize(sp);

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset) qs.set('offset', String(offset));

  // `page.total` counts what the pruner has left for this operator, not every
  // request they have ever made — the route is a capped convenience tail. It is
  // still the real answer to "is there another page", which the old
  // `{requests: […]}` wrapper could not give at all.
  const { items: requests, page } = await api<Page<ApiRequestLogRow>>({
    method: 'GET',
    path: `/api/v1/tenant/auth/requests?${qs.toString()}`,
  });

  return (
    <section className="px-6 py-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold">My requests</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-500 mt-1">
          Recent requests made to the Rekey API under your operator session — the panel issues
          these on your behalf as you navigate. Newest first. Captured best-effort and capped to
          your most recent requests.
        </p>
      </div>

      {requests.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-8 text-center text-sm text-neutral-600 dark:text-neutral-500">
          No requests recorded yet.
        </div>
      ) : (
        <RequestLogTable rows={requests} />
      )}

      <Pager
        basePath="/account/activity"
        offset={offset}
        pageSize={PAGE_SIZE}
        count={requests.length}
        hasMore={page.hasMore}
      />
    </section>
  );
}
