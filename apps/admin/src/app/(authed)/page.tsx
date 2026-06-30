import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Card, SectionHeader } from '@/components/Card';
import { Badge, statusTone } from '@/components/Badge';
import { adminGetSafe } from '@/lib/api';
import { fmtCount, fmtMoney, fmtRelative, fmtPercent, fmtDuration } from '@/lib/format';
import { DateTime } from '@/components/DateTime';
import type {
  OverviewMetrics,
  ServiceHealth,
  RetentionMetrics,
  SecurityEventRow,
  RequestLogRow,
  Paginated,
} from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function OverviewPage(): Promise<React.JSX.Element> {
  // Fetch every panel in parallel so the page paints in one round-trip even
  // when the API is slow on one query. `adminGetSafe` returns null on error so
  // a single failure doesn't take down the whole page.
  const [overview, services, retention, recentEventsPage, recentRequestsPage] = await Promise.all([
    adminGetSafe<OverviewMetrics>('/api/v1/admin/metrics/overview'),
    adminGetSafe<ServiceHealth>('/api/v1/admin/metrics/services'),
    adminGetSafe<RetentionMetrics>('/api/v1/admin/metrics/retention'),
    adminGetSafe<Paginated<SecurityEventRow>>('/api/v1/admin/metrics/security-events?limit=8'),
    adminGetSafe<Paginated<RequestLogRow>>('/api/v1/admin/metrics/api-requests?limit=8'),
  ]);
  // These two endpoints are paginated; the overview only wants the top-N slice.
  const recentEvents = recentEventsPage?.items ?? null;
  const recentRequests = recentRequestsPage?.items ?? null;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Read-only deployment summary. Counts update on every page load."
        action={
          <span className="text-xs text-[var(--color-muted-fg)]">
            Loaded at <DateTime iso={new Date().toISOString()} /> · refresh to update
          </span>
        }
      />

      {!overview && (
        <Card className="border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)]">
          <p className="text-sm font-medium text-[var(--color-danger)]">
            Could not load metrics. Check that the API is reachable and that{' '}
            <code className="font-mono">SUPER_ADMIN_KEY</code> matches.
          </p>
        </Card>
      )}

      {overview && (
        <section className="space-y-3">
          <SectionHeader title="Counts" description="Live totals across the deployment." />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="Tenants"
              value={fmtCount(overview.tenants.total)}
              sublabel={`+${fmtCount(overview.tenants.newLast30d)} in 30d`}
            />
            <StatCard
              label="Applications"
              value={fmtCount(overview.applications.total)}
              sublabel={`+${fmtCount(overview.applications.newLast30d)} in 30d`}
            />
            <StatCard
              label="End-users"
              value={fmtCount(overview.endUsers.total)}
              sublabel={`${fmtCount(overview.endUsers.verified)} verified · +${fmtCount(overview.endUsers.newLast30d)} in 30d`}
            />
            <StatCard
              label="Organizations"
              value={fmtCount(overview.organizations.total)}
              sublabel={`+${fmtCount(overview.organizations.newLast30d)} in 30d`}
            />
            <StatCard
              label="MRR"
              value={fmtMoney(overview.mrrCents)}
              sublabel={
                overview.mrrCapped
                  ? `${fmtCount(overview.subscriptions.active)} active subs · lower bound (read capped)`
                  : `${fmtCount(overview.subscriptions.active)} active subs`
              }
              tone={overview.mrrCapped ? 'warning' : 'default'}
            />
            <StatCard
              label="Lifetime revenue"
              value={fmtMoney(overview.payments.lifetime.volumeCents)}
              sublabel={`${fmtCount(overview.payments.lifetime.count)} payments`}
            />
            <StatCard
              label="30d revenue"
              value={fmtMoney(overview.payments.last30d.volumeCents)}
              sublabel={`${fmtCount(overview.payments.last30d.count)} payments`}
            />
            <StatCard
              label="Operators"
              value={fmtCount(overview.tenantUsers.total)}
              sublabel={`${fmtCount(overview.tenantUsers.activeLast30d)} active in 30d`}
            />
          </div>
        </section>
      )}

      {overview && (
        <section className="space-y-3">
          <SectionHeader title="Last 24 hours" description="Recent activity windows." />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="New end-users 24h"
              value={fmtCount(overview.endUsers.newLast24h)}
              sublabel={`+${fmtCount(overview.endUsers.newLast7d)} in 7d`}
            />
            <StatCard
              label="API requests 24h"
              value={fmtCount(overview.apiRequests.last24h)}
              sublabel={`avg ${fmtDuration(overview.apiRequests.avgDurationMs)}`}
            />
            <StatCard
              label="4xx 24h"
              value={fmtCount(overview.apiRequests.errors4xxLast24h)}
              tone={overview.apiRequests.errors4xxLast24h > 0 ? 'warning' : 'default'}
              sublabel="client errors"
            />
            <StatCard
              label="5xx 24h"
              value={fmtCount(overview.apiRequests.errors5xxLast24h)}
              tone={overview.apiRequests.errors5xxLast24h > 0 ? 'danger' : 'default'}
              sublabel="server errors"
            />
            <StatCard
              label="Webhook events 24h"
              value={fmtCount(overview.webhooks.eventsLast24h)}
              sublabel="inbound from providers"
            />
            <StatCard
              label="Webhook deliveries 24h"
              value={fmtCount(overview.webhooks.deliveriesLast24h)}
              sublabel={`${fmtCount(overview.webhooks.deliveriesFailedLast24h)} failed`}
              tone={overview.webhooks.deliveriesFailedLast24h > 0 ? 'warning' : 'default'}
            />
            <StatCard
              label="Payments 24h"
              value={fmtCount(overview.payments.succeededLast24h)}
              sublabel={`${fmtCount(overview.payments.failedLast24h)} failed`}
              tone={overview.payments.failedLast24h > 0 ? 'warning' : 'positive'}
            />
            <StatCard
              label="Past-due subs"
              value={fmtCount(overview.subscriptions.pastDue)}
              sublabel={`${fmtCount(overview.subscriptions.canceled)} canceled · ${fmtCount(overview.subscriptions.expired)} expired · ${fmtCount(overview.subscriptions.pending)} pending`}
              tone={overview.subscriptions.pastDue > 0 ? 'warning' : 'default'}
            />
            <StatCard
              label="Locked accounts"
              value={fmtCount(overview.lockedAccountsCount)}
              sublabel="end-users in lockout window"
              tone={overview.lockedAccountsCount > 0 ? 'warning' : 'default'}
            />
            <StatCard
              label="Outstanding credits"
              value={fmtCount(overview.outstandingCredits)}
              sublabel="prepaid units not yet consumed"
            />
            <StatCard
              label="Email 24h"
              value={`${fmtCount(overview.emailLast24h.sent)} sent`}
              sublabel={
                overview.emailLast24h.error > 0
                  ? `${fmtCount(overview.emailLast24h.error)} errors · ${fmtCount(overview.emailLast24h.noTransport)} no-transport`
                  : `${fmtCount(overview.emailLast24h.noTransport)} no-transport`
              }
              tone={overview.emailLast24h.error > 0 ? 'danger' : 'default'}
            />
          </div>
        </section>
      )}

      {retention && (
        <section className="space-y-3">
          <SectionHeader
            title="Retention"
            description="Active = had a refresh-token created in the window (sign-in or rotation)."
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Card>
              <h3 className="mb-3 text-sm font-semibold">End-users active</h3>
              <div className="grid grid-cols-3 gap-3">
                <ActiveCell label="24h" value={retention.endUsersActive.last24h} />
                <ActiveCell label="7d" value={retention.endUsersActive.last7d} />
                <ActiveCell label="30d" value={retention.endUsersActive.last30d} />
              </div>
            </Card>
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Operators active</h3>
              <div className="grid grid-cols-3 gap-3">
                <ActiveCell label="24h" value={retention.operatorsActive.last24h} />
                <ActiveCell label="7d" value={retention.operatorsActive.last7d} />
                <ActiveCell label="30d" value={retention.operatorsActive.last30d} />
              </div>
            </Card>
          </div>
          <Card>
            <h3 className="mb-3 text-sm font-semibold">New end-user signups · last 14 days</h3>
            {retention.signupTrend14d.length === 0 ? (
              <p className="text-sm text-[var(--color-muted-fg)]">No signups in the last 14 days.</p>
            ) : (
              <SignupBars data={retention.signupTrend14d} />
            )}
          </Card>
        </section>
      )}

      {services && (
        <section className="space-y-3">
          <SectionHeader
            title="Services"
            description="Live infrastructure pings + webhook health."
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card>
              <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">API</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium">
                <Badge tone={statusTone(services.api.status)}>{services.api.status}</Badge>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted-fg)]">checked {fmtRelative(services.api.checkedAt)}</p>
            </Card>
            <Card>
              <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">Database</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium">
                <Badge tone={statusTone(services.database.status)}>{services.database.status}</Badge>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted-fg)]">{fmtDuration(services.database.latencyMs)}</p>
            </Card>
            <Card>
              <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">Redis</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium">
                <Badge tone={services.redis.status === 'not_configured' ? 'default' : statusTone(services.redis.status)}>
                  {services.redis.status}
                </Badge>
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted-fg)]">{services.redis.latencyMs !== null ? fmtDuration(services.redis.latencyMs) : '—'}</p>
            </Card>
            <Card>
              <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">Webhook 24h</p>
              <p className="mt-1 text-sm font-medium tabular-nums">{fmtPercent(services.webhookDeliverySuccessRate24h)}</p>
              <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
                {services.oldestUnprocessedWebhookAgeSeconds !== null
                  ? `oldest pending ${Math.floor(services.oldestUnprocessedWebhookAgeSeconds / 60)}m`
                  : 'no pending'}
              </p>
            </Card>
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-3">
          <SectionHeader
            title="Recent security events"
            action={
              <Link
                href="/audit"
                className="text-xs font-medium text-[var(--color-primary)] hover:underline"
              >
                View all →
              </Link>
            }
          />
          <Card padded={false}>
            {!recentEvents || recentEvents.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[var(--color-muted-fg)]">No recent events.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)] text-sm">
                {recentEvents.map((e) => (
                  <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">{e.type}</p>
                      <p className="text-xs text-[var(--color-muted-fg)]">
                        {e.actorType}
                        {e.actorId ? ` · ${e.actorId.slice(0, 12)}…` : ''}
                        {e.ip ? ` · ${e.ip}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-[var(--color-muted-fg)]">{fmtRelative(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-3">
          <SectionHeader
            title="Recent API requests"
            action={
              <Link
                href="/requests"
                className="text-xs font-medium text-[var(--color-primary)] hover:underline"
              >
                View all →
              </Link>
            }
          />
          <Card padded={false}>
            {!recentRequests || recentRequests.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[var(--color-muted-fg)]">No recent requests.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)] text-sm">
                {recentRequests.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex items-center gap-2">
                      <Badge tone={r.statusCode >= 500 ? 'danger' : r.statusCode >= 400 ? 'warning' : 'positive'}>
                        {r.statusCode}
                      </Badge>
                      <span className="font-mono text-xs">{r.method}</span>
                      <span className="truncate font-mono text-xs">{r.routePath}</span>
                    </div>
                    <span className="shrink-0 text-xs text-[var(--color-muted-fg)] tabular-nums">{fmtDuration(r.durationMs)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>
    </>
  );
}

function ActiveCell({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-md bg-[var(--color-surface-muted)] px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">{label}</p>
      <p
        className="font-feature text-xl font-semibold tabular-nums"
        style={{ fontFamily: 'var(--font-feature), ui-serif, Georgia, serif' }}
      >
        {fmtCount(value)}
      </p>
    </div>
  );
}

function SignupBars({ data }: { data: Array<{ date: string; count: number }> }): React.JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-1 h-24">
      {data.map((d) => {
        const heightPct = Math.max(4, Math.round((d.count / max) * 100));
        return (
          <div key={d.date} className="flex-1 min-w-0 flex flex-col items-center gap-1" title={`${d.date}: ${d.count}`}>
            <div
              className="w-full rounded-t bg-[var(--color-primary)]"
              style={{ height: `${heightPct}%`, minHeight: '2px' }}
            />
            <span className="truncate text-[9px] text-[var(--color-faint-fg)]">{d.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
