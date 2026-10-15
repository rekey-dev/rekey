import * as React from 'react';
import Link from '@/components/Link';
import { api, type BillingStatsRow, type DunningCaseRow, type PaymentRow, getApplication, unlessBusy } from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import { formatMoney } from '@/lib/format';
import { formatDateTime } from '@/lib/date';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { StatusPill } from '@/components/StatusPill';
import { EmptyState } from '@/components/EmptyState';
import { StatTile } from '@/components/StatTile';
import { hasScope } from '@/lib/operator-scopes';
import { Badge } from '@/components/Badge';
import { currencyFigures, monthlySeries, unverifiedMoney } from '@/lib/revenue';
import { RevenueChart } from './RevenueChart';

/**
 * Billing overview, the Billing group's landing tab: stat tiles in the
 * reporting currency, unverified money as its own figure, a table with one
 * row per currency, one monthly chart per currency, and the most recent
 * payments. Fed by GET /tenant/applications/:id/billing/stats.
 */

export default async function BillingOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const basePath = `/api/v1/tenant/applications/${encodeURIComponent(id)}`;

  const app = await getApplication(id);

  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Billing overview"
          description="Revenue and subscription health for this application."
        />
        <EmptyState
          title="Billing is disabled for this application"
          description="Turn billing on and configure a provider to start selling plans. Revenue stats will appear here."
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
  const [stats, paymentPage, dunningPage] = await Promise.all([
    api<BillingStatsRow>({ method: 'GET', path: `${basePath}/billing/stats`, interruptOnAccessError: false }).catch(
      unlessBusy(() => null),
    ),
    api<Page<PaymentRow>>({ method: 'GET', path: `${basePath}/payments?limit=8` }).catch(unlessBusy(() =>
      emptyPage<PaymentRow>(8),
    )),
    api<Page<DunningCaseRow>>({
      method: 'GET',
      path: `${basePath}/dunning?status=OPEN&limit=100`,
    }).catch(unlessBusy(() => emptyPage<DunningCaseRow>(100))),
  ]);

  const recentPayments = paymentPage.items;
  const openDunning = dunningPage.items;

  // Every figure is per currency and leads with the reporting currency.
  // Nothing is converted or added across currencies.
  const reporting = stats?.reportingCurrency ?? app.billingConfig.reportingCurrency;
  const figures = stats ? currencyFigures(stats) : [];
  const headline = figures[0];
  const others = figures.slice(1);
  const charts = stats ? monthlySeries(stats) : [];
  const unverified = stats ? unverifiedMoney(stats) : [];
  const unverifiedPayments = unverified.reduce((sum, entry) => sum + entry.payments, 0);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Billing overview"
        description={
          <>
            Revenue and subscription health for this application, in {reporting} first because that is its{' '}
            <Link href={`/applications/${id}/billing/settings`} className="underline hover:text-[var(--color-fg)]">
              reporting currency
            </Link>
            . There is no conversion: each currency keeps its own totals and they are never added together.
            Revenue counts verified payments, after any coupon discount.
          </>
        }
      />

      {stats && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <StatTile
            title="Active subscriptions"
            value={stats.activeSubscriptions.toLocaleString()}
            href={`/applications/${id}/plans`}
            footer={`${stats.newSubscriptionsLast30d} new · ${stats.canceledLast30d} canceled (30d)`}
          />
          <StatTile
            title={`MRR in ${reporting}`}
            value={formatMoney(headline?.mrr ?? 0, reporting)}
            href={`/applications/${id}/plans`}
            footer={
              others.some((row) => row.mrr !== 0)
                ? `${reporting} subscriptions only. Other currencies are listed below.`
                : 'Each subscription at its own price, yearly counted as a twelfth'
            }
          />
          <StatTile
            title="Past due"
            value={stats.pastDueSubscriptions.toLocaleString()}
            href={
              hasScope(app.access.scopes, 'end-users:read')
                ? `/applications/${id}/end-users?subscription=PAST_DUE`
                : null
            }
            footer="Subscriptions in dunning"
            tone={stats.pastDueSubscriptions > 0 ? 'warn' : undefined}
          />
          <StatTile
            title={`Net revenue in ${reporting} (30d)`}
            value={formatMoney(headline?.net ?? 0, reporting)}
            href={`/applications/${id}/payments?status=SUCCEEDED`}
            footer={
              (headline?.refunded ?? 0) > 0
                ? `${formatMoney(headline?.gross ?? 0, reporting)} gross less ${formatMoney(headline?.refunded ?? 0, reporting)} refunded`
                : `${headline?.payments ?? 0} verified payment${headline?.payments === 1 ? '' : 's'}`
            }
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
            footer="Open payment recovery cases"
            tone={openDunning.length > 0 ? 'warn' : undefined}
          />
        </div>
      )}

      {!stats && (
        <EmptyState
          variant="inline"
          title="Revenue numbers could not be read"
          description="The billing stats request failed. Reload the page to try again; recent payments below are unaffected."
        />
      )}

      {stats && unverified.length > 0 && (
        <section
          aria-labelledby="unverified-heading"
          className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-5 text-amber-700 dark:text-amber-400"
        >
          <h3 id="unverified-heading" className="text-sm font-medium">
            Unverified money: {unverifiedPayments} payment{unverifiedPayments === 1 ? '' : 's'} held, not counted as revenue
          </h3>
          <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm">
            {unverified.map((entry) => (
              <li key={entry.currency}>
                {formatMoney(entry.amount, entry.currency)}
                <span className="ml-1.5 font-sans text-xs">
                  in {entry.payments} payment{entry.payments === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 max-w-prose text-xs">
            A provider took these charges and Rekey could not match them to what a subscription pays: another
            currency, a very different amount, or no subscription at all. Nothing was granted for them and
            they are in neither revenue nor MRR, whatever their age. Applying one to a subscription verifies
            it and moves it into revenue. Refunding it sends it back.{' '}
            <Link href={`/applications/${id}/unapplied-payments`} className="font-medium underline">
              Review unapplied payments
            </Link>
          </p>
        </section>
      )}

      {stats && (
        <section className="space-y-3" aria-labelledby="by-currency-heading">
          <h3 id="by-currency-heading" className="text-sm font-medium">
            By currency
          </h3>
          <Table minWidth="min-w-[52rem]">
            <caption className="sr-only">
              Monthly recurring revenue and the last 30 days of revenue, one row per currency, never added together
            </caption>
            <THead>
              <TR>
                <TH>Currency</TH>
                <TH align="right">MRR</TH>
                <TH align="right">Active subscriptions</TH>
                <TH align="right">Gross (30d)</TH>
                <TH align="right">Refunded (30d)</TH>
                <TH align="right">Net (30d)</TH>
                <TH align="right">Payments (30d)</TH>
              </TR>
            </THead>
            <TBody>
              {figures.map((row) => (
                <TR key={row.currency}>
                  <TD>
                    <span className="font-mono">{row.currency}</span>
                    {row.currency === reporting && (
                      <Badge tone="brand" className="ml-1.5">
                        reporting
                      </Badge>
                    )}
                  </TD>
                  <TD align="right" mono>{formatMoney(row.mrr, row.currency)}</TD>
                  <TD align="right" mono>{row.activeSubscriptions.toLocaleString('en-US')}</TD>
                  <TD align="right" mono>{formatMoney(row.gross, row.currency)}</TD>
                  <TD align="right" mono>{formatMoney(row.refunded, row.currency)}</TD>
                  <TD align="right" mono>{formatMoney(row.net, row.currency)}</TD>
                  <TD align="right" mono>{row.payments.toLocaleString('en-US')}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="max-w-prose text-xs text-[var(--color-muted-fg)]">
            There is no total row. A local price may be set for what buyers in that country can pay, so
            adding currencies together, or converting them, would report money nobody was charged.
          </p>
        </section>
      )}

      {/* One chart per currency, each on its own scale. Never stacked. */}
      {stats && (
        <section className="space-y-3" aria-labelledby="monthly-heading">
          <h3 id="monthly-heading" className="text-sm font-medium">
            Revenue by month, last 12 months
          </h3>
          <div className={`grid gap-4 ${charts.length > 1 ? 'lg:grid-cols-2' : ''}`}>
            {charts.map((series) => (
              <div
                key={series.currency}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
              >
                <div className="mb-4 flex items-baseline justify-between gap-2">
                  <h4 className="font-mono text-sm font-medium">{series.currency}</h4>
                  <span className="text-xs text-[var(--color-muted-fg)]">
                    {formatMoney(series.total, series.currency)} in 12 months
                  </span>
                </div>
                <RevenueChart series={series} />
              </div>
            ))}
          </div>
          {charts.length > 1 && (
            <p className="text-xs text-[var(--color-muted-fg)]">
              Each chart is scaled to its own currency, so bar heights compare months within one chart and
              not one currency with another.
            </p>
          )}
        </section>
      )}

      {/* Short tail here; the Payments tab has filters + paging. */}
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
                    <Link
                      href={`/applications/${id}/payments/${encodeURIComponent(p.id)}`}
                      className="underline decoration-[var(--color-border)] underline-offset-2 hover:text-[var(--color-fg)]"
                    >
                      {formatDateTime(p.createdAt)}
                    </Link>
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
                    <StatusPill status={p.status} />
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
