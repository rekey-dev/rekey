import * as React from 'react';
import { formatDateTime } from '@/lib/date';
import type { ApiRequestLogRow } from '@/lib/api';

/**
 * Read-only table for the per-request access log. Shared by the per-Application
 * Requests tab and the operator's "My requests" account view — both render the
 * same row shape (api_request_logs), so the markup lives here once.
 */

function statusTone(code: number): string {
  if (code >= 500) return 'text-red-600 dark:text-red-400';
  if (code >= 400) return 'text-amber-600 dark:text-amber-400';
  if (code >= 300) return 'text-blue-600 dark:text-blue-400';
  return 'text-green-600 dark:text-green-400';
}

function methodTone(method: string): string {
  switch (method) {
    case 'GET':
      return 'text-blue-600 dark:text-blue-400';
    case 'POST':
      return 'text-green-600 dark:text-green-400';
    case 'PATCH':
    case 'PUT':
      return 'text-amber-600 dark:text-amber-400';
    case 'DELETE':
      return 'text-red-600 dark:text-red-400';
    default:
      return 'text-[var(--color-muted-fg)]';
  }
}

export function RequestLogTable({
  rows,
}: {
  rows: ApiRequestLogRow[];
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-surface-muted)] text-left text-xs text-neutral-600 dark:text-neutral-400">
          <tr>
            <th className="px-4 py-2 font-medium">Method</th>
            <th className="px-4 py-2 font-medium">Route</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Duration</th>
            <th className="px-4 py-2 font-medium">IP</th>
            <th className="px-4 py-2 font-medium">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className={`px-4 py-2 text-xs font-mono font-medium ${methodTone(r.method)}`}>
                {r.method}
              </td>
              <td title={r.routePath} className="px-4 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300 truncate max-w-[22rem]">
                {r.routePath}
              </td>
              <td className={`px-4 py-2 text-xs font-mono font-medium ${statusTone(r.statusCode)}`}>
                {r.statusCode}
              </td>
              <td className="px-4 py-2 text-xs font-mono text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                {r.durationMs} ms
              </td>
              <td className="px-4 py-2 text-xs font-mono text-neutral-600 dark:text-neutral-400">
                {r.ip ?? '—'}
              </td>
              <td className="px-4 py-2 text-xs text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                {formatDateTime(r.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
