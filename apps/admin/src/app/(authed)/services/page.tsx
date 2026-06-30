import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { Badge, statusTone } from '@/components/Badge';
import { DateTime } from '@/components/DateTime';
import { adminGetSafe, type ServiceHealth } from '@/lib/api';
import { fmtDuration, fmtPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ServicesPage(): Promise<React.JSX.Element> {
  const services = await adminGetSafe<ServiceHealth>('/api/v1/admin/metrics/services');

  return (
    <>
      <PageHeader
        title="Services"
        description="Live infrastructure pings. Refresh the page to re-probe."
      />

      {!services ? (
        <Card><p className="text-sm text-[var(--color-muted-fg)]">Could not reach the API.</p></Card>
      ) : (
        <>
          <section className="space-y-3">
            <SectionHeader title="Live probes" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <ServiceRow
                label="API"
                statusBadge={<Badge tone={statusTone(services.api.status)}>{services.api.status}</Badge>}
                detail={<>Checked <DateTime iso={services.api.checkedAt} /></>}
              />
              <ServiceRow
                label="Database (Postgres)"
                statusBadge={<Badge tone={statusTone(services.database.status)}>{services.database.status}</Badge>}
                detail={`Ping ${fmtDuration(services.database.latencyMs)}`}
              />
              <ServiceRow
                label="Redis"
                statusBadge={
                  <Badge tone={services.redis.status === 'not_configured' ? 'default' : statusTone(services.redis.status)}>
                    {services.redis.status}
                  </Badge>
                }
                detail={services.redis.latencyMs !== null ? `Ping ${fmtDuration(services.redis.latencyMs)}` : 'no client configured'}
              />
              <ServiceRow
                label="Outbound webhooks · 24h"
                statusBadge={
                  services.webhookDeliverySuccessRate24h === null ? (
                    <Badge>no data</Badge>
                  ) : services.webhookDeliverySuccessRate24h >= 0.95 ? (
                    <Badge tone="positive">{fmtPercent(services.webhookDeliverySuccessRate24h)}</Badge>
                  ) : services.webhookDeliverySuccessRate24h >= 0.8 ? (
                    <Badge tone="warning">{fmtPercent(services.webhookDeliverySuccessRate24h)}</Badge>
                  ) : (
                    <Badge tone="danger">{fmtPercent(services.webhookDeliverySuccessRate24h)}</Badge>
                  )
                }
                detail="Success rate (SUCCEEDED / total) over 24h"
              />
            </div>
          </section>

          <section className="space-y-3">
            <SectionHeader title="Queue health" />
            <Card>
              <p className="text-sm">
                Oldest unprocessed inbound webhook:{' '}
                <strong>
                  {services.oldestUnprocessedWebhookAgeSeconds === null
                    ? 'none pending'
                    : `${Math.floor(services.oldestUnprocessedWebhookAgeSeconds / 60)}m old`}
                </strong>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
                A growing age here means the inbound webhook processor is stuck or backed up.
                Healthy: under a minute. Investigate above 5 minutes.
              </p>
            </Card>
          </section>
        </>
      )}
    </>
  );
}

function ServiceRow({
  label,
  statusBadge,
  detail,
}: {
  label: string;
  statusBadge: React.ReactNode;
  detail: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">{detail}</p>
        </div>
        {statusBadge}
      </div>
    </Card>
  );
}
