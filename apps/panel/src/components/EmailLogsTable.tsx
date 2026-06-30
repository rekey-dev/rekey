import * as React from 'react';
import type { EmailLogWithApp } from '@/lib/api';
import { formatDateTime } from '@/lib/date';
import { Table, THead, TBody, TR, TH, TD } from './Table';
import { Badge, type BadgeTone } from './Badge';
import { EmptyState } from './EmptyState';
import { DEFAULT_PAGE_SIZE } from './Pager';

const VIA_LABEL: Record<string, string> = {
  byo_resend: 'Resend',
  byo_smtp: 'SMTP',
  default_resend: 'Default Resend',
  none: '—',
};

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const tone: BadgeTone = status === 'sent' ? 'success' : status === 'error' ? 'danger' : 'warning';
  return <Badge tone={tone}>{status}</Badge>;
}

/**
 * Read-only email send-log table. Used by both the per-application and the
 * workspace-wide (per-tenant) views; set `showApp` to render the owning-app
 * column (the workspace view) — per-app pages omit it.
 */
export function EmailLogsTable({
  rows,
  showApp = false,
}: {
  rows: EmailLogWithApp[];
  showApp?: boolean;
}): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState title="No email sends recorded yet" />;
  }
  return (
    <Table minWidth="min-w-[56rem]">
      <THead>
        <TR>
          <TH>When</TH>
          {showApp && <TH>App</TH>}
          <TH>To</TH>
          <TH>Subject</TH>
          <TH>Event</TH>
          <TH>Via</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id} hover>
            <TD muted className="whitespace-nowrap text-xs">
              {formatDateTime(r.createdAt)}
            </TD>
            {showApp && (
              <TD className="text-xs">
                {r.application ? (
                  r.application.name
                ) : (
                  <span className="italic text-[var(--color-muted-fg)]">system</span>
                )}
              </TD>
            )}
            <TD>{r.toAddress}</TD>
            <TD className="max-w-[18rem] truncate" >
              <span title={r.subject}>{r.subject}</span>
            </TD>
            <TD mono muted>{r.eventKey ?? '—'}</TD>
            <TD muted className="whitespace-nowrap text-xs">
              {VIA_LABEL[r.via] ?? r.via}
            </TD>
            <TD>
              <div className="space-y-1">
                <StatusBadge status={r.status} />
                {r.status === 'error' && r.error && (
                  <div
                    className="max-w-[16rem] truncate text-[11px] text-red-600 dark:text-red-400"
                    title={r.error}
                  >
                    {r.error}
                  </div>
                )}
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/**
 * Status filter pills shared by both log views. `basePath` is the page URL.
 *
 * Changing the filter resets `offset` to page 1 (correct — a new filter is a
 * new result set) but PRESERVES the active page size (`ps`), so the user's
 * 10/25/100 choice survives a filter click, matching `Pager`'s own link
 * behaviour. Pass `pageSize` from the page's `readPageSize(sp)`.
 */
export function EmailLogStatusFilter({
  basePath,
  active,
  pageSize,
}: {
  basePath: string;
  active: string | undefined;
  pageSize?: number;
}): React.JSX.Element {
  const opts: Array<{ value: string | undefined; label: string }> = [
    { value: undefined, label: 'All' },
    { value: 'sent', label: 'Sent' },
    { value: 'error', label: 'Errors' },
    { value: 'no_transport', label: 'No transport' },
  ];
  const buildHref = (value: string | undefined): string => {
    const p = new URLSearchParams();
    if (value) p.set('status', value);
    // Preserve a non-default page size; offset intentionally omitted (reset to page 1).
    if (pageSize !== undefined && pageSize !== DEFAULT_PAGE_SIZE) p.set('ps', String(pageSize));
    const s = p.toString();
    return `${basePath}${s ? `?${s}` : ''}`;
  };
  return (
    <div className="flex items-center gap-1.5">
      {opts.map((o) => {
        const href = buildHref(o.value);
        const isActive = active === o.value || (!active && !o.value);
        return (
          <a
            key={o.label}
            href={href}
            className={
              'text-xs px-2.5 py-1 rounded-md border ' +
              (isActive
                ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[var(--color-primary)]/5'
                : 'border-[var(--color-border)] text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)]')
            }
          >
            {o.label}
          </a>
        );
      })}
    </div>
  );
}
