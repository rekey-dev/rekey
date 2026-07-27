import * as React from 'react';
import Link from 'next/link';
import { api, type ApplicationRow, type DunningCaseRow } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { formatDateTime } from '@/lib/date';
import { Pager, readPageSize, DEFAULT_PAGE_SIZE } from '@/components/Pager';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD, readSort, sortToggleHref } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { BillingModeBanner } from '@/components/BillingModeBanner';

/**
 * Dunning — failed-payment recovery cases. One case per subscription's trip
 * through PAST_DUE: reminder emails at day 0/3/7, exhaustion (subscription
 * canceled) at day 14 without recovery. The provider drives the actual card
 * retries — this table is the operator's visibility into recovery state.
 */

const STATUSES = ['OPEN', 'RECOVERED', 'EXHAUSTED', 'CANCELED'] as const;
type DunningStatus = (typeof STATUSES)[number];

const STATUS_TONE: Record<DunningStatus, BadgeTone> = {
  OPEN: 'warning',
  RECOVERED: 'success',
  EXHAUSTED: 'danger',
  CANCELED: 'neutral',
};

/** Friendly labels for display — the raw enum still goes to the API. */
const STATUS_LABEL: Record<DunningStatus, string> = {
  OPEN: 'Open',
  RECOVERED: 'Recovered',
  EXHAUSTED: 'Exhausted',
  CANCELED: 'Canceled',
};

const inputCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

export default async function DunningPage({
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
      ? (sp.status as DunningStatus)
      : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const sorted = readSort(sp, ['openedAt', 'nextActionAt', 'status'] as const);

  // Billing master switch off → point at the switch instead of an empty table.
  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Dunning"
          description="Dunning recovers failed payments — Rekey emails the customer and tracks recovery automatically."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const dunningEnabled = app.billingConfig.dunningEnabled ?? false;

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset) qs.set('offset', String(offset));
  if (status) qs.set('status', status);
  if (sorted) {
    qs.set('sort', sorted.sort);
    qs.set('order', sorted.order);
  }

  const cases = await api<DunningCaseRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/dunning?${qs.toString()}`,
  });

  const filtered = Boolean(status);
  const filterParams: Record<string, string> = {};
  if (status) filterParams.status = status;
  const extraParams: Record<string, string> = {
    ...filterParams,
    ...(sorted ? { sort: sorted.sort, order: sorted.order } : {}),
  };
  const basePath = `/applications/${id}/dunning`;
  const sortTH = (column: 'openedAt' | 'nextActionAt' | 'status') =>
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
        title="Dunning"
        count={`(${cases.length === 0 ? 0 : `${offset + 1}–${offset + cases.length}`})`}
        description="Dunning recovers failed payments — Rekey emails the customer and tracks recovery automatically. A case opens when a subscription goes past due, reminders go out on day 0/3/7, and the subscription is canceled on day 14 without recovery. Card retries themselves are driven by the billing provider."
      />

      {!dunningEnabled && (
        <div
          role="note"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-muted-fg)]"
        >
          <span className="font-medium text-[var(--color-fg)]">Failed-payment recovery is off.</span>{' '}
          Past-due subscriptions get no reminder emails and aren’t auto-cancelled — the provider’s own
          retries still run.{' '}
          {cases.length > 0 &&
            'The cases below opened while it was on and finish on their existing schedule. '}
          <Link
            href={`/applications/${id}/billing`}
            className="underline hover:text-[var(--color-fg)]"
          >
            Turn it on in billing settings
          </Link>
          .
        </div>
      )}

      {/* When dunning is off and there are no in-flight cases, don't render the
          filter + table scaffolding — an empty cases table reads as if the
          feature were active. Show a disabled state instead. Existing cases (a
          turn-off mid-flight) still render so the operator keeps visibility. */}
      {!dunningEnabled && cases.length === 0 ? (
        <EmptyState
          title="Dunning is off"
          description="Turn on failed-payment recovery to have Rekey chase failed payments with reminder emails and auto-cancel unpaid subscriptions after 14 days."
          action={
            <Link
              href={`/applications/${id}/billing`}
              className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
            >
              Go to billing settings
            </Link>
          }
        />
      ) : (
        <>
      <form className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">Status</span>
          <select name="status" defaultValue={status ?? ''} className={inputCls}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
        >
          Apply
        </button>
        {filtered && (
          <a
            href={basePath}
            className="px-1 py-2 text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
          >
            filtered — clear
          </a>
        )}
      </form>

      {cases.length === 0 ? (
        <EmptyState
          title={filtered ? 'No cases match this filter' : 'No dunning cases'}
          description={
            filtered
              ? 'Try clearing the status filter.'
              : 'Nothing in recovery — a case appears here when a subscription payment fails and the subscription goes past due.'
          }
        />
      ) : (
        <Table minWidth="min-w-[60rem]">
          <THead>
            <TR>
              <TH sort={sortTH('openedAt')}>When</TH>
              <TH>End-user</TH>
              <TH>Plan</TH>
              <TH sort={sortTH('status')}>Status</TH>
              <TH align="right">Failures</TH>
              <TH align="right">Reminders</TH>
              <TH sort={sortTH('nextActionAt')}>Next action</TH>
              <TH>Closed</TH>
            </TR>
          </THead>
          <TBody>
            {cases.map((c) => (
              <TR key={c.id} hover>
                <TD muted className="whitespace-nowrap text-xs">
                  {formatDateTime(c.openedAt)}
                </TD>
                <TD>
                  {c.endUserId && c.endUserEmail ? (
                    <Link
                      href={`/applications/${id}/end-users/${c.endUserId}`}
                      className="text-sm text-[var(--color-fg)] hover:underline"
                    >
                      {c.endUserEmail}
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--color-muted-fg)]">—</span>
                  )}
                </TD>
                <TD muted className="max-w-[10rem] truncate text-xs" title={c.planName}>
                  {c.planSlug}
                </TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    <Badge tone={STATUS_TONE[c.status]} dot>
                      {STATUS_LABEL[c.status]}
                    </Badge>
                    {/* Test/live isolation: flag sandbox dunning cases (mirrors payments). */}
                    {c.mode === 'TEST' && <Badge tone="info">TEST</Badge>}
                  </span>
                </TD>
                <TD align="right" mono>
                  {c.failedAttempts}
                </TD>
                <TD align="right" mono>
                  {c.remindersSent}/3
                </TD>
                <TD muted className="whitespace-nowrap text-xs">
                  {c.status === 'OPEN' && c.nextActionAt ? formatDateTime(c.nextActionAt) : '—'}
                </TD>
                <TD muted className="whitespace-nowrap text-xs">
                  {c.closedAt ? formatDateTime(c.closedAt) : '—'}
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
        count={cases.length}
        extraParams={Object.keys(extraParams).length ? extraParams : undefined}
      />
        </>
      )}
    </div>
  );
}
