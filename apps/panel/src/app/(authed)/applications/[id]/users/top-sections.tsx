import * as React from 'react';
import type { AnalyticsActivity, AnalyticsActivitySegment, AnalyticsKpis, AnalyticsMetric } from '@rekey.dev/shared-types';
import { StatTile } from '@/components/StatTile';
import { LineChart } from '@/components/charts/LineChart';
import { StackedBars } from '@/components/charts/StackedBars';
import { formatDate } from '@/lib/date';
import { formatCount, formatExact, formatShare } from '@/lib/metric-format';
import { SIGN_IN_METHODS, usersHref, viaName, type UsersFilters, type UsersView } from '@/lib/users-filters';
import { describeDelta, type Section, type UsersAnalytics } from '@/lib/users-analytics';
import { SectionShell } from './section-shell';
import { MetricSwitch } from './metric-switch';

const METRIC_LABEL = { dau: 'Daily active', wau: 'Weekly active', mau: 'Monthly active' } as const;

export function KpiRow({
  section,
  retryHref,
  endUsersHref,
  gapFixHref,
}: {
  section: Section<AnalyticsKpis> | undefined;
  retryHref: string;
  endUsersHref: string | null;
  gapFixHref?: string | undefined;
}): React.JSX.Element {
  return (
    <SectionShell title="Key numbers" section={section} retryHref={retryHref} gapFixHref={gapFixHref} bare>
      {(k) => (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <CountTile
            title="Total users"
            m={k.totalUsers}
            href={endUsersHref}
            footer={k.totalUsers.erased > 0 ? `includes ${formatCount(k.totalUsers.erased)} erased` : 'every account, now'}
          />
          <CountTile title="New users" m={k.newUsers} footer="accounts created in range" />
          <CountTile
            title="Active on the last day"
            m={k.dau}
            footer={k.dauAverage.value !== null ? `${formatCount(Math.round(k.dauAverage.value))} a day on average` : 'daily active users'}
          />
          <CountTile title="Weekly active" m={k.wau} footer="7 days to the end of the range" />
          <CountTile title="Monthly active" m={k.mau} footer="30 days to the end of the range" />
          <CountTile
            title="Paying users"
            m={k.payingUsers}
            footer={k.conversion.value !== null ? `${formatShare(k.conversion.value)} of all users, now` : 'active, trialing or past due, now'}
          />
        </div>
      )}
    </SectionShell>
  );
}

function CountTile({
  title,
  m,
  footer,
  href,
}: {
  title: string;
  m: AnalyticsMetric;
  footer?: string | undefined;
  href?: string | null;
}): React.JSX.Element {
  if (m.value === null) {
    return <StatTile title={title} value="—" footer="not available for this range, see the note below" muted />;
  }
  const delta = describeDelta(m, 'count');
  return (
    <StatTile
      title={title}
      value={formatCount(m.value)}
      valueTitle={formatExact(m.value)}
      footer={footer}
      href={href}
      delta={
        delta === null
          ? null
          : { ...delta, reason: delta.reason ?? (m.previous !== null ? `Previous period: ${formatExact(m.previous)}` : undefined) }
      }
    />
  );
}

/** A series from one segment's points, for the chosen measure and its previous period. */
function lineSeries(seg: AnalyticsActivitySegment, metric: UsersView['metric'], compare: boolean) {
  const current = seg.points.map((p) => p[metric]);
  const previous = seg.points.map((p) => (p.previous ? p.previous[metric] : null));
  return [
    { key: 'current', label: 'This period', values: current },
    ...(compare && previous.some((v) => v !== null)
      ? [{ key: 'previous', label: 'Previous period', values: previous, dashed: true }]
      : []),
  ];
}

export function ActivitySection({
  section,
  analytics,
  appId,
  filters,
  view,
  retryHref,
  stickiness,
  gapFixHref,
}: {
  section: Section<AnalyticsActivity> | undefined;
  analytics: UsersAnalytics;
  appId: string;
  filters: UsersFilters;
  view: UsersView;
  retryHref: string;
  stickiness: AnalyticsMetric | null;
  gapFixHref?: string | undefined;
}): React.JSX.Element {
  const zone = section?.status === 'ok' ? section.timezone : analytics.range.timezone;
  const exactFromFor = { dau: analytics.coverage.activityFrom, wau: analytics.coverage.wauFrom, mau: analytics.coverage.mauFrom };
  const charts = (a: AnalyticsActivity, metric: UsersView['metric']): React.ReactNode =>
    a.segments.map((seg) => {
      const exactFrom = exactFromFor[metric];
      const labels = seg.points.map((p) => p.date);
      const missing = seg.timezone === 'UTC' ? labels.findIndex((d) => d >= exactFrom) : -1;
      return (
        <div key={`${seg.timezone}:${seg.from}`} className="mt-2 first:mt-0">
          {a.segments.length > 1 && (
            <p className="mb-1 text-xs text-[var(--color-muted-fg)]">
              {formatDate(seg.from)} to {formatDate(seg.to)}, days counted in {seg.timezone}
            </p>
          )}
          <LineChart
            title={`${METRIC_LABEL[metric]} users`}
            labels={labels}
            axisNote={seg.timezone}
            series={lineSeries(seg, metric, filters.compare === 'prev')}
            unavailableBefore={missing > 0 ? missing : undefined}
            unavailableLabel={missing > 0 ? `No exact ${metric.toUpperCase()} before ${formatDate(exactFrom)}` : undefined}
          />
        </div>
      );
    });
  return (
    <div className="space-y-4">
      <SectionShell
        title="Active users"
        description={`People who signed in or refreshed a session, counted per ${zone} day.`}
        section={section}
        retryHref={retryHref}
        gapFixHref={gapFixHref}
      >
        {(a) => (
          <>
            <MetricSwitch
              initial={view.metric}
              options={(['dau', 'wau', 'mau'] as const).map((m) => ({
                value: m,
                label: { dau: 'Daily', wau: 'Weekly', mau: 'Monthly' }[m],
                href: usersHref(appId, filters, { ...view, metric: m }),
              }))}
              panels={{ dau: charts(a, 'dau'), wau: charts(a, 'wau'), mau: charts(a, 'mau') }}
              aside={
                stickiness && stickiness.value !== null ? (
                  <span className="text-xs text-[var(--color-muted-fg)]" title="Average daily active users divided by monthly active users">
                    Stickiness <span className="font-medium tabular-nums text-[var(--color-fg)]">{formatShare(stickiness.value)}</span>
                  </span>
                ) : undefined
              }
            />
            {analytics.coverage.timezoneNote && (
              <p className="mt-2 text-xs text-[var(--color-muted-fg)]">{analytics.coverage.timezoneNote}</p>
            )}
          </>
        )}
      </SectionShell>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionShell
          title="Sign-ins by method"
          description="Each sign-in, by the method used for it."
          section={section}
          retryHref={retryHref}
          footnote="Password + MFA counts a password sign-in that also passed a second factor."
        >
          {(a) => {
            const s = a.signIns;
            if (s.status !== 'ok') {
              return (
                <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-muted-fg)]">
                  {s.reason === 'needs_rollup' ? 'Needs daily history, which this deployment is still collecting.' : 'Not recorded.'}{' '}
                  {s.fix}
                </p>
              );
            }
            return (
              <>
                {s.partial && (
                  <p className="mb-2 text-xs text-[var(--color-muted-fg)]">
                    Only part of this range has sign-in history
                    {analytics.coverage.signInsFrom ? `, from ${formatDate(analytics.coverage.signInsFrom)}` : ''}. Earlier days
                    need the daily history.
                  </p>
                )}
                {s.ignoredFilters.length > 0 && (
                  <p className="mb-2 text-xs text-[var(--color-muted-fg)]">Not filtered by {s.ignoredFilters.join(', ')}.</p>
                )}
                <StackedBars
                  title="Sign-ins by method"
                  labels={s.points.map((p) => p.date)}
                  axisNote={s.timezone}
                  series={methodsIn(s.points).map((m) => ({
                    key: m,
                    label: viaName(m),
                    values: s.points.map((p) => p.byVia[m] ?? 0),
                  }))}
                />
              </>
            );
          }}
        </SectionShell>

        <SectionShell
          title="Accounts created"
          description="New accounts per day, and the total number of accounts."
          section={section}
          retryHref={retryHref}
          footnote="Includes accounts you created, imported, or that a billing event created."
        >
          {(a) => {
            const points = a.segments.flatMap((seg) => seg.points);
            let running = a.accountsBefore;
            const total = points.map((p) => (running += p.accountsCreated));
            return (
              <StackedBars
                title="Accounts created"
                labels={points.map((p) => p.date)}
                axisNote={a.segments.length === 1 ? a.segments[0]!.timezone : undefined}
                series={[{ key: 'new', label: 'New accounts', values: points.map((p) => p.accountsCreated) }]}
                line={{ label: 'Total accounts', values: total }}
              />
            );
          }}
        </SectionShell>
      </div>
    </div>
  );
}

/** Methods present in the data, in the canonical order, unknown ones last. */
function methodsIn(points: Array<{ byVia: Record<string, number> }>): string[] {
  const seen = new Set(points.flatMap((d) => Object.keys(d.byVia)));
  const known = SIGN_IN_METHODS.filter((m) => seen.has(m));
  return [...known, ...[...seen].filter((m) => !(SIGN_IN_METHODS as readonly string[]).includes(m)).sort()];
}
