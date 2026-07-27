import * as React from 'react';
import Link from 'next/link';
import { api, type ApiRequestLogRow } from '@/lib/api';
import { RequestLogTable } from '@/components/RequestLogTable';
import { EmptyState } from '@/components/EmptyState';
import { Pager, readPageSize } from '@/components/Pager';

/**
 * Per-Application request log. Inbound calls to this app's public API with its
 * secret key, newest first. Captured best-effort by a global response hook and
 * capped per app by a periodic pruner — a convenience tail for "what's hitting
 * my API right now", not a billing-grade audit trail.
 */

export default async function RequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const PAGE_SIZE = readPageSize(sp);

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset) qs.set('offset', String(offset));

  const { requests } = await api<{ requests: ApiRequestLogRow[] }>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/requests?${qs.toString()}`,
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-medium">Requests</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-500 mt-1">
          API calls your backend made to Rekey — useful for debugging your integration. Method,
          route, status, and latency per request, newest first. Captured best-effort and capped to
          the most recent requests; informational, not a billing-grade audit trail.
        </p>
      </div>

      {requests.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No API requests recorded yet"
          description={
            <>
              Calls made with this app&apos;s secret key
              (<code className="font-mono">rp_live_…</code> / <code className="font-mono">rp_test_…</code>)
              appear here.
            </>
          }
          action={
            <Link
              href={`/applications/${id}/api-keys`}
              className="text-sm font-medium text-[var(--color-primary)] hover:underline"
            >
              View API keys →
            </Link>
          }
        />
      ) : (
        <RequestLogTable rows={requests} />
      )}

      <Pager basePath={`/applications/${id}/requests`} offset={offset} pageSize={PAGE_SIZE} count={requests.length} />
    </div>
  );
}
