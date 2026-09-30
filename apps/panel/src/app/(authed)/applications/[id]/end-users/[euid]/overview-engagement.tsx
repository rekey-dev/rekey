/**
 * The Overview's second row of tiles: how much this person actually uses the
 * product. Sign-ins, active days, platforms and security factors, each linking
 * to the tab that holds the detail. A tile shows a dash when insights could not
 * be read, since zero is a claim about the account and a failed read is not.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { Card, SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/Badge';
import { formatDate, formatDateTime, formatRelative } from '@/lib/date';
import { StatTile } from '@/components/StatTile';
import { plural } from '@/lib/format';
import { describeSource, platformLabel, type EndUserInsightsDto } from './insights';

export function EngagementTiles({
  insights,
  base,
}: {
  insights: EndUserInsightsDto | null;
  base: string;
}): React.JSX.Element {
  if (!insights) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {['Sign-ins', 'Active days', 'Platforms', 'Security'].map((title) => (
          <StatTile key={title} title={title} value="—" footer="engagement could not be read" href={`${base}/security`} />
        ))}
      </div>
    );
  }
  const { signIns, activity, platforms, sources, security } = insights;
  const browsers = new Set(sources.map((s) => s.browser).filter(Boolean)).size;
  const countries = new Set(sources.map((s) => s.country).filter(Boolean)).size;
  const factors = [
    security.mfaEnabled ? 'MFA on' : 'MFA off',
    security.passkeys > 0 ? plural(security.passkeys, 'passkey') : null,
    ...security.oauthProviders.map((p) => `${p[0]!.toUpperCase()}${p.slice(1)} linked`),
  ].filter(Boolean);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        title="Sign-ins"
        value={signIns.count.toLocaleString()}
        footer={`since ${formatDate(signIns.trackedSince)}`}
        href={`${base}/security`}
      />
      <StatTile
        title="Active days"
        value={`${activity.activeDaysLast30} of 30`}
        footer={
          !activity.lastActiveOn
            ? 'not active yet'
            : activity.last63
              ? `${activity.activeDaysLast7} in the last 7 · ${activity.last63.filter(Boolean).length} in 9 weeks`
              : `${activity.activeDaysLast7} in the last 7 · last ${activity.lastActiveOn}`
        }
        href={`${base}/security`}
      >
        {activity.last63 ? <ActivityGrid days={activity.last63} /> : <ActivityStrip days={activity.last30} />}
      </StatTile>
      <StatTile
        title="Platforms"
        value={platforms.seen.length === 0 ? 'None yet' : platforms.seen.map(platformLabel).join(', ')}
        footer={`${plural(browsers, 'browser')}, ${plural(countries, 'country', 'countries')}`}
        href={`${base}/devices`}
      />
      <StatTile
        title="Security"
        value={security.mfaEnabled ? 'MFA on' : 'MFA off'}
        footer={factors.slice(1).join(' · ') || 'no passkeys or linked providers'}
        href={`${base}/security`}
      />
    </div>
  );
}

/**
 * Nine weeks as a heat grid, one column per week and today bottom right: the
 * whole window the activity bits remember, the same shape as the retention
 * grid on Users > Overview.
 */
function ActivityGrid({ days }: { days: boolean[] }): React.JSX.Element {
  const active = days.filter(Boolean).length;
  return (
    <span
      role="img"
      className="mt-1 grid max-w-[14rem] grid-flow-col grid-rows-7 gap-[2px]"
      aria-label={`${active} active days in the last ${days.length}`}
      title={`${active} active days in the last ${days.length} (UTC days)`}
    >
      {days.map((on, i) => (
        <span
          key={i}
          className={`h-2 rounded-[2px] ${
            on ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface-muted)] ring-1 ring-inset ring-[var(--color-border)]'
          }`}
        />
      ))}
    </span>
  );
}

/** One cell per day, oldest left, today right. */
function ActivityStrip({ days }: { days: boolean[] }): React.JSX.Element {
  return (
    <span className="mt-1 flex gap-[2px]" aria-label={`${days.filter(Boolean).length} active days in the last 30`}>
      {days.map((active, i) => (
        <span
          key={i}
          className={`h-3 flex-1 rounded-[2px] ${
            active ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface-muted)] ring-1 ring-inset ring-[var(--color-border)]'
          }`}
        />
      ))}
    </span>
  );
}

/** "Where they sign in from": the five newest places, from their sessions. */
export function SignInSources({
  insights,
  base,
}: {
  insights: EndUserInsightsDto | null;
  base: string;
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Where they sign in from"
        description="Recent sessions grouped by platform, browser and country. Country comes from Cloudflare and is blank when unknown."
        action={
          <Link
            href={`${base}/devices`}
            className="text-xs text-[var(--color-muted-fg)] underline underline-offset-2 hover:text-[var(--color-fg)]"
          >
            Devices →
          </Link>
        }
      />
      {insights === null ? (
        <EmptyState variant="inline" title="Sessions could not be read" description="Reload to try again." />
      ) : insights.sources.length === 0 ? (
        <EmptyState variant="inline" title="No sessions yet" description="This user has not signed in since sessions were recorded." />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-[var(--color-border)]">
            {insights.sources.map((s) => (
              <li key={`${s.platform}|${s.os}|${s.browser}|${s.country}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="flex min-w-0 items-center gap-2 text-sm text-[var(--color-fg)]">
                  <span className="truncate">{describeSource(s)}</span>
                  <Badge tone="neutral" mono>
                    {platformLabel(s.platform)}
                  </Badge>
                  {s.country && (
                    <Badge tone="neutral" mono>
                      {s.country}
                    </Badge>
                  )}
                  {s.live && (
                    <Badge tone="success" dot>
                      live
                    </Badge>
                  )}
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs text-[var(--color-muted-fg)]" title={formatDateTime(s.lastSeenAt)}>
                  {plural(s.sessions, 'session')} · {formatRelative(s.lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
