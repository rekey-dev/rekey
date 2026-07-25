import * as React from 'react';
import Link from 'next/link';
import {
  api,
  type ApplicationRow,
  type BillingStatsRow,
  type DunningCaseRow,
  type PaymentRow,
} from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { formatDateTime } from '@/lib/date';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';

/**
 * Billing Overview — the Billing group's landing tab. Revenue/subscription
 * stat tiles fed by GET /tenant/applications/:id/billing/stats, a 12-month
 * revenue chart (inline SVG, same no-deps approach as the app overview's
 * sign-up trend), and the most recent payments with a link to the full
 * Payments tab.
 */

const PAYMENT_STATUS_TONE: Record<PaymentRow['status'], BadgeTone> = {
  SUCCEEDED: 'success',
  PENDING: 'warning',
  FAILED: 'danger',
  REFUNDED: 'neutral',
};

/** Friendly labels for display — the raw enum still comes from the API. */
const PAYMENT_STATUS_LABEL: Record<PaymentRow['status'], string> = {
  SUCCEEDED: 'Succeeded',
  PENDING: 'Pending',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
};

export default async function BillingOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const basePath = `/api/v1/tenant/applications/${encodeURIComponent(id)}`;

  const app = await api<ApplicationRow>({ method: 'GET', path: basePath });

  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Billing overview"
          description="Revenue and subscription health for this application."
        />
        <EmptyState
          title="Billing is disabled for this application"
          description="Turn billing on and configure a provider to start selling plans — revenue stats will appear here."
          action={
            <Link
              href={`/applications/${id}/billing`}
              className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:opacity-90"
            >
              Go to billing settings
            </Link>
          }
        />
      </div>
    );
  }

  // Stats + recent payments + open dunning cases in parallel; the page stays
  // useful if one fails.
  const [stats, recentPayments, openDunning] = await Promise.all([
    api<BillingStatsRow>({ method: 'GET', path: `${basePath}/billing/stats` }).catch(() => null),
    api<PaymentRow[]>({ method: 'GET', path: `${basePath}/payments?limit=8` }).catch(
      () => [] as PaymentRow[],
    ),
    api<DunningCaseRow[]>({ method: 'GET', path: `${basePath}/dunning?status=OPEN&limit=100` }).catch(
      () => [] as DunningCaseRow[],
    ),
  ]);

  const currency = app.billingConfig.currency || 'USD';

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Billing overview"
        description="Revenue and subscription health for this application. Amounts reflect what the provider settled, after any coupon discount. Live mode data only — test-mode subscriptions and payments are excluded."
      />

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatTile
            title="Active subscriptions"
            value={stats.activeSubscriptions.toLocaleString()}
            href={`/applications/${id}/plans`}
            footer={`${stats.newSubscriptionsLast30d} new · ${stats.canceledLast30d} canceled (30d)`}
          />
          <StatTile
            title="MRR"
            value={formatMoney(stats.mrrCents, stats.mrrCurrency ?? currency)}
            href={`/applications/${id}/plans`}
            footer={
              stats.mixedCurrencies
                ? `${stats.mrrCurrency} plans only — other currencies excluded`
                : 'Recurring plans, yearly normalized to monthly'
            }
          />
          <StatTile
            title="Past due"
            value={stats.pastDueSubscriptions.toLocaleString()}
            href={`/applications/${id}/end-users?subscription=PAST_DUE`}
            footer="Subscriptions in dunning"
            tone={stats.pastDueSubscriptions > 0 ? 'warn' : undefined}
          />
          <StatTile
            title="Revenue (30d)"
            value={formatMoney(stats.revenueLast30dCents, currency)}
            href={`/applications/${id}/payments?status=SUCCEEDED`}
            footer={`${stats.paymentsLast30d.succeeded} successful payment${stats.paymentsLast30d.succeeded === 1 ? '' : 's'}`}
          />
          <StatTile
            title="Failed payments (30d)"
            value={stats.paymentsLast30d.failed.toLocaleString()}
            href={`/applications/${id}/payments?status=FAILED`}
            footer="Declines and reversals"
            tone={stats.paymentsLast30d.failed > 0 ? 'warn' : undefined}
          />
          <StatTile
            title="Dunning"
            value={`${openDunning.length}${openDunning.length >= 100 ? '+' : ''}`}
            href={`/applications/${id}/dunning?status=OPEN`}
            footer="Open recovery cases · reminders day 0/3/7"
            tone={openDunning.length > 0 ? 'warn' : undefined}
          />
        </div>
      )}

      {/* Revenue over the last 12 months — the headline graph. */}
      {stats && (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Revenue</h3>
            <span className="text-xs text-[var(--color-muted-fg)]">
              last 12 months ·{' '}
              {formatMoney(
                stats.monthlyRevenue.reduce((s, m) => s + m.amountCents, 0),
                currency,
              )}{' '}
              total · live mode data
            </span>
          </div>
          <RevenueBarChart data={stats.monthlyRevenue} currency={currency} />
        </section>
      )}

      {/* Recent payments — a short tail; the Payments tab has filters + paging. */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Recent payments</h3>
          <Link
            href={`/applications/${id}/payments`}
            className="text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline"
          >
            View all payments →
          </Link>
        </div>
        {recentPayments.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No payments yet"
            description="Payments appear here once a provider webhook confirms money moved (checkout completed, invoice paid)."
          />
        ) : (
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH>When</TH>
                <TH>End-user</TH>
                <TH align="right">Amount</TH>
                <TH>Status</TH>
                <TH>Description</TH>
              </TR>
            </THead>
            <TBody>
              {recentPayments.map((p) => (
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
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone={PAYMENT_STATUS_TONE[p.status]} dot>
                        {PAYMENT_STATUS_LABEL[p.status]}
                      </Badge>
                      {/* Recent payments span both modes — flag sandbox rows. */}
                      {p.mode === 'TEST' && <Badge tone="info">TEST</Badge>}
                    </span>
                  </TD>
                  <TD muted className="max-w-[16rem] truncate text-xs" title={p.description ?? undefined}>
                    {p.description ?? '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}

/** Compact metric tile — same pattern as the app Overview page's tiles. */
function StatTile({
  title,
  value,
  footer,
  href,
  tone,
}: {
  title: string;
  value: string;
  footer: string;
  href: string;
  tone?: 'warn' | undefined;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-1 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
    >
      <span className="text-xs text-neutral-600 dark:text-neutral-500">{title}</span>
      <span
        className={`text-2xl font-semibold tabular-nums ${
          tone === 'warn' ? 'text-amber-600 dark:text-amber-500' : ''
        }`}
      >
        {value}
      </span>
      <span className="text-xs text-[var(--color-muted-fg)] leading-snug">{footer}</span>
    </Link>
  );
}

/**
 * Inline SVG bar chart for the 12-month revenue series. No chart library —
 * same approach as the overview page's sign-up AreaChart. One bar per month,
 * scaled to the series max; months render even when zero so gaps are visible.
 */
function RevenueBarChart({
  data,
  currency,
}: {
  data: Array<{ month: string; amountCents: number }>;
  currency: string;
}): React.JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.amountCents));
  const total = data.reduce((s, d) => s + d.amountCents, 0);
  // "2026-06" → "Jun" (UTC, matching the API's UTC month bucketing).
  const monthLabel = (key: string): string => {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleString('en', {
      month: 'short',
      timeZone: 'UTC',
    });
  };

  return (
    <div className="mt-4">
      {/* Screen-reader equivalent of the visual chart: hover titles on the
          bars aren't focusable, so the values live in this sr-only table. */}
      <table className="sr-only">
        <caption>Revenue by month, last 12 months</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}>
              <th scope="row">{d.month}</th>
              <td>{formatMoney(d.amountCents, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div aria-hidden="true">
        <div className="flex items-end gap-1.5 h-32">
          {data.map((d) => (
            <div key={d.month} className="flex-1 flex flex-col items-center gap-1 min-w-0 h-full justify-end">
              <div
                className="w-full rounded-sm bg-[color-mix(in_srgb,var(--color-primary)_70%,transparent)] hover:bg-[var(--color-primary)] transition-colors"
                style={{ height: `${Math.max(d.amountCents === 0 ? 1 : 4, (d.amountCents / max) * 100)}%` }}
                title={`${d.month}: ${formatMoney(d.amountCents, currency)}`}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-1.5 mt-1">
          {data.map((d) => (
            <span key={d.month} className="flex-1 text-center text-[10px] text-[var(--color-muted-fg)] truncate">
              {monthLabel(d.month)}
            </span>
          ))}
        </div>
      </div>
      {total === 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted-fg)]">
          No settled revenue yet — successful payments will chart here month by month.
        </p>
      )}
    </div>
  );
}
