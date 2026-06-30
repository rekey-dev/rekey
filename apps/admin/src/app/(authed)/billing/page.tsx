import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, statusTone } from '@/components/Badge';
import { SearchForm, FilterChips, buildQs } from '@/components/SearchForm';
import { Pagination } from '@/components/Pagination';
import { DateTime } from '@/components/DateTime';
import { CopyButton } from '@/components/CopyButton';
import { adminGetSafe, type Paginated, type SubscriptionRow, type PaymentRow, type CreditLiability, type PaymentsByAppRow } from '@/lib/api';
import { fmtCount, fmtMoney, fmtPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const SUB_STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PAST_DUE', label: 'Past due' },
  { value: 'CANCELED', label: 'Canceled' },
  { value: 'EXPIRED', label: 'Expired' },
];
const PAY_STATUSES = [
  { value: 'SUCCEEDED', label: 'Succeeded' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'REFUNDED', label: 'Refunded' },
];

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const subStatus = typeof params.subStatus === 'string' ? params.subStatus : undefined;
  const payStatus = typeof params.payStatus === 'string' ? params.payStatus : undefined;
  const q = typeof params.q === 'string' ? params.q : undefined;
  const subPage = Math.max(1, Number(params.subPage) || 1);
  const payPage = Math.max(1, Number(params.payPage) || 1);

  const subsQs = buildQs({ status: subStatus, q, limit: PAGE_SIZE, offset: (subPage - 1) * PAGE_SIZE });
  const paysQs = buildQs({ status: payStatus, q, limit: PAGE_SIZE, offset: (payPage - 1) * PAGE_SIZE });

  const [subscriptions, payments, credits, payHealth] = await Promise.all([
    adminGetSafe<Paginated<SubscriptionRow>>(`/api/v1/admin/metrics/subscriptions${subsQs}`),
    adminGetSafe<Paginated<PaymentRow>>(`/api/v1/admin/metrics/payments${paysQs}`),
    adminGetSafe<CreditLiability>('/api/v1/admin/metrics/credit-liability'),
    adminGetSafe<PaymentsByAppRow[]>('/api/v1/admin/metrics/payments-by-app'),
  ]);

  const subColumns: Column<SubscriptionRow>[] = [
    {
      key: 'id',
      header: 'Subscription',
      render: (s) => (
        <div>
          <p className="flex items-center gap-1 font-mono text-[11px]">
            <span className="truncate">{s.id}</span>
            <CopyButton value={s.id} />
          </p>
          <p className="flex items-center gap-1 text-xs text-[var(--color-muted-fg)]">
            user {s.endUserId.slice(0, 12)}…
            <CopyButton value={s.endUserId} label={`Copy ${s.endUserId}`} />
          </p>
        </div>
      ),
    },
    { key: 'app', header: 'App', render: (s) => <span className="font-mono text-[11px]">{s.applicationSlug}</span> },
    {
      key: 'plan',
      header: 'Plan',
      render: (s) => (
        <div>
          <p>{s.planName}</p>
          <p className="font-mono text-[11px] text-[var(--color-faint-fg)]">{s.planSlug}</p>
        </div>
      ),
    },
    { key: 'price', header: 'Price', align: 'right', render: (s) => `${fmtMoney(s.amount, s.currency)} / ${s.interval.toLowerCase()}` },
    { key: 'status', header: 'Status', render: (s) => <Badge tone={statusTone(s.status)}>{s.status}</Badge> },
    { key: 'period', header: 'Period end', render: (s) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={s.currentPeriodEnd} /></span> },
    { key: 'created', header: 'Created', render: (s) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={s.createdAt} /></span> },
  ];

  const paymentColumns: Column<PaymentRow>[] = [
    { key: 'id', header: 'Payment', render: (p) => (
      <span className="inline-flex items-center gap-1 font-mono text-[11px]">
        {p.id}
        <CopyButton value={p.id} />
      </span>
    ) },
    { key: 'app', header: 'App', render: (p) => <span className="font-mono text-[11px]">{p.applicationSlug}</span> },
    {
      key: 'user',
      header: 'End-user',
      render: (p) => <span className="font-mono text-[11px] text-[var(--color-muted-fg)]">{p.endUserId ? `${p.endUserId.slice(0, 12)}…` : '—'}</span>,
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (p) => fmtMoney(p.amount, p.currency) },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={statusTone(p.status)}>{p.status}</Badge> },
    { key: 'created', header: 'Created', render: (p) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={p.createdAt} /></span> },
  ];

  return (
    <>
      <PageHeader
        title="Billing"
        description="Read-only view of subscriptions and payment attempts."
        action={
          <SearchForm
            initialValue={q}
            placeholder="id / provider-id / end-user id"
            hidden={{ subStatus, payStatus }}
          />
        }
      />

      {credits && credits.totalOutstanding > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Outstanding credits"
            description={`${fmtCount(credits.totalOutstanding)} prepaid units bought but not yet consumed across the deployment. Operator liability if the customer's app shuts down.`}
          />
          <DataTable<typeof credits.perApp[number]>
            rows={credits.perApp}
            columns={[
              { key: 'app', header: 'Application', render: (r) => (
                <div>
                  <p>{r.applicationName}</p>
                  <p className="font-mono text-[11px] text-[var(--color-faint-fg)]">{r.applicationSlug}</p>
                </div>
              ) },
              { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => fmtCount(r.outstanding) },
            ]}
            getKey={(r) => r.applicationId}
            emptyMessage="No credits issued anywhere."
          />
        </section>
      )}

      {payHealth && payHealth.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Payment health by app (30d)"
            description="Apps sorted by failure count. Persistent failures suggest a broken provider integration (Stripe / PayPal / Razorpay)."
          />
          <DataTable<PaymentsByAppRow>
            rows={payHealth}
            columns={[
              { key: 'app', header: 'Application', render: (r) => (
                <div>
                  <p>{r.applicationName}</p>
                  <p className="font-mono text-[11px] text-[var(--color-faint-fg)]">{r.applicationSlug}</p>
                </div>
              ) },
              { key: 'succeeded', header: 'Succeeded', align: 'right', render: (r) => fmtCount(r.succeeded) },
              { key: 'failed', header: 'Failed', align: 'right', render: (r) => (
                <span className={r.failed > 0 ? 'text-[var(--color-danger)]' : ''}>{fmtCount(r.failed)}</span>
              ) },
              { key: 'rate', header: 'Success rate', align: 'right', render: (r) => (
                <span title="Succeeded / (Succeeded + Failed). Pending + refunded ignored.">
                  {fmtPercent(r.successRate)}
                </span>
              ) },
              { key: 'volume', header: 'Volume', align: 'right', render: (r) => fmtMoney(r.volumeCents) },
            ]}
            getKey={(r) => r.applicationId}
            emptyMessage="No payment activity in the last 30 days."
          />
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader title="Subscriptions" count={subscriptions ? `(${fmtCount(subscriptions.total)})` : ''} />
        <FilterChips
          label="Status"
          options={SUB_STATUSES}
          active={subStatus}
          buildHref={(v) => buildQs({ subStatus: v, payStatus, q })}
        />
        {!subscriptions ? (
          <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not load subscriptions.</p></Card>
        ) : (
          <>
            <DataTable<SubscriptionRow>
              rows={subscriptions.items}
              columns={subColumns}
              getKey={(s) => s.id}
              emptyMessage={subStatus ? `No ${subStatus} subscriptions.` : 'No subscriptions yet.'}
            />
            <Pagination
              page={subPage}
              pageSize={PAGE_SIZE}
              total={subscriptions.total}
              buildHref={(p) => buildQs({ subStatus, payStatus, q, subPage: p, payPage })}
            />
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Payments" count={payments ? `(${fmtCount(payments.total)})` : ''} />
        <FilterChips
          label="Status"
          options={PAY_STATUSES}
          active={payStatus}
          buildHref={(v) => buildQs({ subStatus, payStatus: v, q })}
        />
        {!payments ? (
          <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not load payments.</p></Card>
        ) : (
          <>
            <DataTable<PaymentRow>
              rows={payments.items}
              columns={paymentColumns}
              getKey={(p) => p.id}
              emptyMessage={payStatus ? `No ${payStatus} payments.` : 'No payments yet.'}
            />
            <Pagination
              page={payPage}
              pageSize={PAGE_SIZE}
              total={payments.total}
              buildHref={(p) => buildQs({ subStatus, payStatus, q, subPage, payPage: p })}
            />
          </>
        )}
      </section>
    </>
  );
}
