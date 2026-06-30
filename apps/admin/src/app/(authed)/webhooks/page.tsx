import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, statusTone } from '@/components/Badge';
import { FilterChips, buildQs } from '@/components/SearchForm';
import { Pagination } from '@/components/Pagination';
import { DateTime } from '@/components/DateTime';
import { adminGetSafe, type Paginated, type WebhookEventRow, type WebhookDeliveryRow, type WebhookEndpointHealthRow } from '@/lib/api';
import { fmtCount, fmtPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const PROVIDERS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'razorpay', label: 'Razorpay' },
];

const DELIVERY_STATUSES = [
  { value: 'SUCCEEDED', label: 'Succeeded' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'PENDING', label: 'Pending' },
];

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const provider = typeof params.provider === 'string' ? params.provider : undefined;
  const onlyFailed = params.onlyFailed === 'true';
  const deliveryStatus = typeof params.deliveryStatus === 'string' ? params.deliveryStatus : undefined;
  const evPage = Math.max(1, Number(params.evPage) || 1);
  const delPage = Math.max(1, Number(params.delPage) || 1);

  const eventsQs = buildQs({ provider, onlyFailed: onlyFailed ? 'true' : undefined, limit: PAGE_SIZE, offset: (evPage - 1) * PAGE_SIZE });
  const deliveriesQs = buildQs({ status: deliveryStatus, limit: PAGE_SIZE, offset: (delPage - 1) * PAGE_SIZE });

  const [events, deliveries, endpointHealth] = await Promise.all([
    adminGetSafe<Paginated<WebhookEventRow>>(`/api/v1/admin/metrics/webhook-events${eventsQs}`),
    adminGetSafe<Paginated<WebhookDeliveryRow>>(`/api/v1/admin/metrics/webhook-deliveries${deliveriesQs}`),
    adminGetSafe<WebhookEndpointHealthRow[]>('/api/v1/admin/metrics/webhook-endpoint-health'),
  ]);

  const eventColumns: Column<WebhookEventRow>[] = [
    { key: 'provider', header: 'Provider', render: (e) => <Badge>{e.provider}</Badge> },
    { key: 'type', header: 'Event', render: (e) => <span className="font-mono text-xs">{e.eventType}</span> },
    { key: 'app', header: 'App', render: (e) => <span className="font-mono text-[11px]">{e.applicationSlug}</span> },
    {
      key: 'status',
      header: 'Processed',
      render: (e) =>
        e.processingError
          ? <Badge tone="danger" className="font-mono">error</Badge>
          : e.processedAt
            ? <Badge tone="positive">processed</Badge>
            : <Badge tone="warning">pending</Badge>,
    },
    {
      key: 'error',
      header: 'Error',
      render: (e) =>
        e.processingError ? (
          <span className="text-xs text-[var(--color-danger)] truncate inline-block max-w-[40ch]" title={e.processingError}>
            {e.processingError}
          </span>
        ) : '—',
    },
    { key: 'received', header: 'Received', render: (e) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={e.receivedAt} /></span> },
  ];

  const deliveryColumns: Column<WebhookDeliveryRow>[] = [
    { key: 'type', header: 'Event', render: (d) => <span className="font-mono text-xs">{d.eventType}</span> },
    { key: 'app', header: 'App', render: (d) => <span className="font-mono text-[11px]">{d.applicationSlug}</span> },
    { key: 'status', header: 'Status', render: (d) => <Badge tone={statusTone(d.status)}>{d.status}</Badge> },
    { key: 'attempts', header: 'Attempts', align: 'right', render: (d) => fmtCount(d.attempts) },
    { key: 'response', header: 'HTTP', align: 'right', render: (d) => d.responseStatus ?? '—' },
    { key: 'created', header: 'Created', render: (d) => <span className="text-xs text-[var(--color-muted-fg)]"><DateTime iso={d.createdAt} /></span> },
  ];

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Inbound provider events and outbound deliveries to customer endpoints."
      />

      {endpointHealth && endpointHealth.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Endpoint health (24h)"
            description="Per-endpoint outbound delivery aggregate. Endpoints with non-zero failures or low success rate are the persistent-failure suspects."
          />
          <DataTable<WebhookEndpointHealthRow>
            rows={endpointHealth}
            columns={[
              { key: 'url', header: 'URL', render: (e) => <span className="font-mono text-xs truncate inline-block max-w-[40ch]" title={e.url}>{e.url}</span> },
              { key: 'app', header: 'App', render: (e) => <span className="font-mono text-[11px]">{e.applicationSlug}</span> },
              { key: 'succeeded', header: 'Succeeded', align: 'right', render: (e) => fmtCount(e.succeeded) },
              { key: 'failed', header: 'Failed', align: 'right', render: (e) => (
                <span className={e.failed > 0 ? 'text-[var(--color-danger)]' : ''}>{fmtCount(e.failed)}</span>
              ) },
              { key: 'pending', header: 'Pending', align: 'right', render: (e) => fmtCount(e.pending) },
              { key: 'rate', header: 'Success rate', align: 'right', render: (e) => fmtPercent(e.successRate) },
            ]}
            getKey={(e) => e.endpointId}
            emptyMessage="No deliveries in the last 24h."
          />
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader title="Inbound provider events" count={events ? `(${fmtCount(events.total)})` : ''} />
        <div className="flex flex-wrap items-center gap-4">
          <FilterChips
            label="Provider"
            options={PROVIDERS}
            active={provider}
            buildHref={(v) => buildQs({ provider: v, onlyFailed: onlyFailed ? 'true' : undefined, deliveryStatus })}
          />
          <FilterChips
            label="Filter"
            options={[{ value: 'true', label: 'Only failed' }]}
            active={onlyFailed ? 'true' : undefined}
            buildHref={(v) => buildQs({ provider, onlyFailed: v, deliveryStatus })}
          />
        </div>
        {!events ? (
          <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not load events.</p></Card>
        ) : (
          <>
            <DataTable<WebhookEventRow>
              rows={events.items}
              columns={eventColumns}
              getKey={(e) => e.id}
              emptyMessage="No inbound webhook events match."
            />
            <Pagination
              page={evPage}
              pageSize={PAGE_SIZE}
              total={events.total}
              buildHref={(p) => buildQs({ provider, onlyFailed: onlyFailed ? 'true' : undefined, deliveryStatus, evPage: p, delPage })}
            />
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Outbound deliveries" count={deliveries ? `(${fmtCount(deliveries.total)})` : ''} />
        <FilterChips
          label="Status"
          options={DELIVERY_STATUSES}
          active={deliveryStatus}
          buildHref={(v) => buildQs({ provider, onlyFailed: onlyFailed ? 'true' : undefined, deliveryStatus: v })}
        />
        {!deliveries ? (
          <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not load deliveries.</p></Card>
        ) : (
          <>
            <DataTable<WebhookDeliveryRow>
              rows={deliveries.items}
              columns={deliveryColumns}
              getKey={(d) => d.id}
              emptyMessage="No outbound deliveries match."
            />
            <Pagination
              page={delPage}
              pageSize={PAGE_SIZE}
              total={deliveries.total}
              buildHref={(p) => buildQs({ provider, onlyFailed: onlyFailed ? 'true' : undefined, deliveryStatus, evPage, delPage: p })}
            />
          </>
        )}
      </section>
    </>
  );
}
