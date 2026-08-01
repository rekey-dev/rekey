import * as React from 'react';
import Link from 'next/link';
import { api, type ApplicationRow, type PaymentRow } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { formatMoney } from '@/lib/format';
import { formatDateTime } from '@/lib/date';
import { Pager, readPageSize, DEFAULT_PAGE_SIZE } from '@/components/Pager';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD, readSort, sortToggleHref } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { BillingModeBanner } from '@/components/BillingModeBanner';

const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] as const;
type PaymentStatus = (typeof STATUSES)[number];

const STATUS_TONE: Record<PaymentStatus, BadgeTone> = {
  SUCCEEDED: 'success',
  PENDING: 'warning',
  FAILED: 'danger',
  REFUNDED: 'neutral',
};

const inputCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

export default async function PaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const status =
    typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status)
      ? (sp.status as PaymentStatus)
      : undefined;
  const from = typeof sp.from === 'string' && sp.from ? sp.from : undefined; // yyyy-mm-dd
  const to = typeof sp.to === 'string' && sp.to ? sp.to : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const sorted = readSort(sp, ['createdAt', 'amount', 'status'] as const);

  // Billing master switch off → point at the switch instead of an empty table.
  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Payments"
          description="Every charge, refund, and decline from your billing providers."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset) qs.set('offset', String(offset));
  if (status) qs.set('status', status);
  // Date inputs are day-granular; make the window inclusive of both ends.
  if (from) qs.set('from', `${from}T00:00:00.000Z`);
  if (to) qs.set('to', `${to}T23:59:59.999Z`);
  if (sorted) {
    qs.set('sort', sorted.sort);
    qs.set('order', sorted.order);
  }

  const payments = await api<PaymentRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/payments?${qs.toString()}`,
  });

  const filtered = Boolean(status || from || to);
  const filterParams: Record<string, string> = {};
  if (status) filterParams.status = status;
  if (from) filterParams.from = from;
  if (to) filterParams.to = to;
  // Pager links must preserve the active sort; sort links must preserve the
  // filters + page size (offset intentionally resets on re-sort).
  const extraParams: Record<string, string> = {
    ...filterParams,
    ...(sorted ? { sort: sorted.sort, order: sorted.order } : {}),
  };
  const basePath = `/applications/${id}/payments`;
  const sortTH = (column: 'createdAt' | 'amount' | 'status') =>
    sortToggleHref({
      basePath,
      column,
      current: sorted,
      extraParams: {
        ...filterParams,
        ...(PAGE_SIZE !== DEFAULT_PAGE_SIZE ? { ps: String(PAGE_SIZE) } : {}),
      },
    });

  return (
    <div className="space-y-5">
      <BillingModeBanner applicationId={id} />

      <SectionHeader
        title="Payments"
        count={`(${payments.length === 0 ? 0 : `${offset + 1}–${offset + payments.length}`})`}
        description="Every payment recorded for this application — subscription invoices and one-time charges, newest first. Amounts are what the provider settled, after any coupon discount."
      />

      <form className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">Status</span>
          <select name="status" defaultValue={status ?? ''} className={inputCls}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">From</span>
          <input type="date" name="from" defaultValue={from ?? ''} className={inputCls} />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">To</span>
          <input type="date" name="to" defaultValue={to ?? ''} className={inputCls} />
        </label>
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
        >
          Apply
        </button>
        {filtered && (
          <a
            href={`/applications/${id}/payments`}
            className="px-1 py-2 text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
          >
            filtered — clear
          </a>
        )}
      </form>

      {payments.length === 0 ? (
        <EmptyState
          title={filtered ? 'No payments match these filters' : 'No payments yet'}
          description={
            filtered
              ? 'Try widening the date range or clearing the status filter.'
              : 'Payments appear here once a provider webhook confirms money moved (checkout completed, invoice paid).'
          }
        />
      ) : (
        <Table minWidth="min-w-[56rem]">
          <THead>
            <TR>
              <TH sort={sortTH('createdAt')}>When</TH>
              <TH>End-user</TH>
              <TH align="right" sort={sortTH('amount')}>Amount</TH>
              <TH sort={sortTH('status')}>Status</TH>
              <TH>Description</TH>
              <TH>Provider payment id</TH>
            </TR>
          </THead>
          <TBody>
            {payments.map((p) => (
              <TR key={p.id} hover>
                <TD muted className="whitespace-nowrap text-xs">
                  {formatDateTime(p.createdAt)}
                </TD>
                <TD>
                  {p.endUserId && p.endUserEmail ? (
                    <Link
                      href={`/applications/${id}/end-users/${p.endUserId}`}
                      className="text-sm text-[var(--color-fg)] hover:underline"
                    >
                      {p.endUserEmail}
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--color-muted-fg)]">—</span>
                  )}
                </TD>
                <TD align="right" mono>
                  {formatMoney(p.amount, p.currency)}
                </TD>
                <TD>
                  <Badge tone={STATUS_TONE[p.status]} dot>
                    {p.status}
                  </Badge>
                </TD>
                <TD muted className="max-w-[16rem] truncate text-xs" title={p.description ?? undefined}>
                  {p.description ?? '—'}
                </TD>
                <TD mono muted className="max-w-[12rem] truncate text-[11px]" title={p.providerPaymentId ?? undefined}>
                  {p.providerPaymentId ?? '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Pager
        basePath={basePath}
        offset={offset}
        pageSize={PAGE_SIZE}
        count={payments.length}
        extraParams={Object.keys(extraParams).length ? extraParams : undefined}
      />
    </div>
  );
}
