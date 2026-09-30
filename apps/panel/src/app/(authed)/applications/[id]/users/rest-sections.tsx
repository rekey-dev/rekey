import * as React from 'react';
import type {
  AnalyticsBillingCounts,
  AnalyticsBreakdown,
  AnalyticsMix,
  AnalyticsOnboarding,
  AnalyticsRetention,
  AnalyticsSecurity,
  AnalyticsUsage,
} from '@rekey.dev/shared-types';
import Link from '@/components/Link';
import { StatTile } from '@/components/StatTile';
import { FilterChips } from '@/components/FilterChips';
import { BarList, type BarListItem } from '@/components/charts/BarList';
import { Funnel } from '@/components/charts/Funnel';
import { RetentionGrid } from '@/components/charts/RetentionGrid';
import { formatDate } from '@/lib/date';
import { formatCount, formatExact, formatShare } from '@/lib/metric-format';
import { createdViaName, platformName, usersHref, viaName, type UsersFilters, type UsersView } from '@/lib/users-filters';
import type { Section } from '@/lib/users-analytics';
import { SectionShell, StateNote } from './section-shell';

const tail = (count: number, total: number): { count: number; share: number } | null =>
  count > 0 ? { count, share: total > 0 ? count / total : 0 } : null;

function Bars({
  title,
  b,
  name = (k) => k,
  empty,
}: {
  title: string;
  b: AnalyticsBreakdown;
  name?: (k: string) => string;
  empty: string;
}): React.JSX.Element {
  if (b.total === 0 || (b.rows.length === 0 && b.other === 0 && b.unknown === 0)) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-xs text-[var(--color-muted-fg)]">
        {empty}
      </p>
    );
  }
  const items: BarListItem[] = b.rows.map((r) => ({ key: r.key, label: name(r.key), count: r.count, share: r.share }));
  return <BarList title={title} items={items} other={tail(b.other, b.total)} unknown={tail(b.unknown, b.total)} />;
}

function capitalise(p: string): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function MixSection({ section, retryHref , gapFixHref }: { section: Section<AnalyticsMix> | undefined; retryHref: string ; gapFixHref?: string | undefined }): React.JSX.Element {
  // One section behind six cards: a failure is shown once, not six times.
  if (section?.status !== 'ok') {
    return (
      <SectionShell gapFixHref={gapFixHref} title="Who they are" section={section} retryHref={retryHref}>
        {() => null}
      </SectionShell>
    );
  }
  const card = (title: string, description: string, pick: (m: AnalyticsMix) => React.ReactNode, footnote?: string): React.JSX.Element => (
    <SectionShell gapFixHref={gapFixHref} title={title} description={description} section={section} retryHref={retryHref} footnote={footnote}>
      {pick}
    </SectionShell>
  );
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">Who they are</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {card('Platform', 'Where each user active in the range last signed in from.', (m) => (
          <Bars title="Platform" b={m.platform} name={platformName} empty="No platform recorded for anyone active in this range." />
        ))}
        {card('Country', 'The same users, by their latest country.', (m) => (
          <Bars
            title="Country"
            b={m.country}
            empty="No countries recorded. This deployment does not trust the CF-IPCountry header; see docs/analytics.md, Country."
          />
        ))}
        {card(
          'Last sign-in method',
          'How each user who signed in during the range last did so.',
          (m) => <Bars title="Last sign-in method" b={m.lastSignInVia} name={viaName} empty="Nobody signed in during this range." />,
          'Password + MFA is a password sign-in that also passed a second factor.',
        )}
        {card(
          'Sign-up source',
          'How the accounts created in this range were made.',
          (m) => <Bars title="Sign-up source" b={m.createdVia} name={createdViaName} empty="No accounts were created in this range." />,
          'Accounts created before sign-up sources were recorded count as Unknown.',
        )}
        {card('Sign-in providers linked', 'Users with each OAuth provider linked, now. One user can count under several.', (m) => (
          <Bars title="Sign-in providers linked" b={m.oauthProviders} name={capitalise} empty="No one has linked a sign-in provider." />
        ))}
        {card('Live sessions', 'Sessions still signed in, by operating system and browser, from the latest daily snapshot.', (m) =>
          m.liveSessions === null ? (
            <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-xs text-[var(--color-muted-fg)]">
              Appears after the first daily snapshot.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-[var(--color-muted-fg)]">As of {formatDate(m.liveSessions.takenOn)}, not filtered.</p>
              <Bars title="Live sessions by operating system" b={m.liveSessions.os} empty="No live sessions." />
              <Bars title="Live sessions by browser" b={m.liveSessions.browser} empty="No browser sessions." />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.round(h / 24)} days`;
}

const STEP_LABEL: Record<AnalyticsOnboarding['funnel']['steps'][number]['key'], string> = {
  created: 'Account created',
  verified: 'Email verified',
  first_sign_in: 'Signed in',
  onboarding_completed: 'Onboarding completed',
  active_7d: 'Active in the last 7 days',
};

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function OnboardingSection({
  section,
  retryHref,
  appId,
  filters,
  view,
  onboardingHref,
  canPickQuestion,
  gapFixHref,
}: {
  section: Section<AnalyticsOnboarding> | undefined;
  retryHref: string;
  appId: string;
  filters: UsersFilters;
  view: UsersView;
  onboardingHref: string | null;
  /** Answers are per-person data: the API serves them only with end-users:read. */
  canPickQuestion: boolean;
  gapFixHref?: string | undefined;
}): React.JSX.Element {
  return (
    <SectionShell
      gapFixHref={gapFixHref}
      title="Onboarding"
      description="The accounts created in this range, step by step. Skipping never blocks anyone; it is recorded so you can see it."
      section={section}
      retryHref={retryHref}
      action={
        onboardingHref ? (
          <Link href={onboardingHref} className="text-xs text-[var(--color-muted-fg)] underline underline-offset-2 hover:text-[var(--color-fg)]">
            Questions →
          </Link>
        ) : undefined
      }
    >
      {(o) => {
        const completion = ratio(o.cohortCounts.completed, o.cohortCounts.total);
        const skip = ratio(o.cohortCounts.skipped, o.cohortCounts.total);
        const picked = o.answers?.key ?? view.field;
        return (
          <div className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Funnel
                title="Onboarding funnel for accounts created in this range"
                steps={o.funnel.steps.map((s) => ({
                  key: s.key,
                  label: STEP_LABEL[s.key],
                  count: s.count,
                  branch: s.key === 'onboarding_completed' ? { label: 'Skipped instead', count: o.funnel.skipped } : undefined,
                }))}
              />
              <div className="grid grid-cols-2 content-start gap-3">
                <StatTile title="Completion" value={completion === null ? '—' : formatShare(completion)} footer="of accounts created in range" />
                <StatTile title="Skipped" value={skip === null ? '—' : formatShare(skip)} footer="of accounts created in range" />
                <StatTile
                  title="Median time to finish"
                  value={o.medianSecondsToComplete === null ? '—' : duration(o.medianSecondsToComplete)}
                  footer="from account creation"
                  className="col-span-2"
                />
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--color-muted-fg)]">Everyone, now</p>
              <div className="grid grid-cols-3 gap-3">
                {(['completed', 'skipped', 'pending'] as const).map((k) => (
                  <div key={k} className="rounded-lg border border-[var(--color-border)] px-3 py-2">
                    <p className="text-xs capitalize text-[var(--color-muted-fg)]">{k}</p>
                    <p className="text-lg font-semibold tabular-nums text-[var(--color-fg)]" title={formatExact(o.counts[k])}>
                      {formatCount(o.counts[k])}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            {canPickQuestion && o.fields.length > 0 && (
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-[var(--color-muted-fg)]">Answers, accounts created in range</p>
                  <FilterChips
                    label="Profile question"
                    active={picked}
                    hrefFor={(f) => usersHref(appId, filters, { ...view, ...(f ? { field: f } : {}) })}
                    chips={o.fields.map((f) => ({ value: f.key, label: f.label }))}
                  />
                </div>
                {o.answers ? (
                  <Bars
                    title={o.answers.label}
                    b={o.answers.breakdown}
                    name={(k) => (k === 'true' ? 'Yes' : k === 'false' ? 'No' : k)}
                    empty="No answers to this question yet."
                  />
                ) : (
                  <p className="text-xs text-[var(--color-muted-fg)]">Pick a question to see how people answered it.</p>
                )}
              </div>
            )}
          </div>
        );
      }}
    </SectionShell>
  );
}

export function RetentionSection({ section, retryHref , gapFixHref }: { section: Section<AnalyticsRetention> | undefined; retryHref: string ; gapFixHref?: string | undefined }): React.JSX.Element {
  return (
    <SectionShell
      gapFixHref={gapFixHref}
      title="Retention"
      description="Of the people who signed up in each 7-day block, the share active in each block after. The blocks end today and count UTC days."
      section={section}
      retryHref={retryHref}
      footnote="The last 8 blocks. Blank cells are blocks that have not happened yet or that the activity data cannot answer."
    >
      {(r) =>
        r.cohorts.every((c) => c.size === 0) ? (
          <StateNote tone="muted" title="No sign-ups in the last 8 weeks" />
        ) : (
          <RetentionGrid
            title="Retention by sign-up week"
            weeks={Math.max(1, ...r.cohorts.map((c) => c.retained.length))}
            cohorts={r.cohorts.map((c) => ({
              week: c.weekStart,
              size: c.size,
              retained: c.retained.map((n) => (n === null || c.size === 0 ? null : n / c.size)),
            }))}
          />
        )
      }
    </SectionShell>
  );
}

export function SecuritySection({
  section,
  retryHref,
  activityHref,
  gapFixHref,
}: {
  section: Section<AnalyticsSecurity> | undefined;
  retryHref: string;
  activityHref: string | null;
  gapFixHref?: string | undefined;
}): React.JSX.Element {
  const share = (s: number | null): string => (s === null ? '—' : formatShare(s));
  return (
    <SectionShell
      gapFixHref={gapFixHref}
      title="Account health"
      description="Everyone who matches the filters, now. The date range does not apply."
      section={section}
      retryHref={retryHref}
      footnote={
        <>
          Failed sign-ins and lockouts are not charted: they are kept only while they matter. The recent ones are listed under{' '}
          {activityHref ? (
            <Link href={activityHref} className="underline underline-offset-2">
              Users &gt; Activity
            </Link>
          ) : (
            'Users > Activity'
          )}
          .
        </>
      }
    >
      {(s) => (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile title="Email verified" value={share(s.verified.share)} footer={`${formatCount(s.verified.count)} of ${formatCount(s.total)}`} />
          <StatTile title="MFA on" value={share(s.mfa.share)} footer={`${formatCount(s.mfa.count)} of ${formatCount(s.total)}`} />
          <StatTile title="Passkeys" value={share(s.passkeys.share)} footer={`${formatCount(s.passkeys.count)} with at least one`} />
          <StatTile
            title="Active devices"
            value={formatCount(s.devices.active)}
            footer={`${formatCount(s.devices.blocked)} blocked · ${formatCount(s.devices.released)} released`}
            tone={s.devices.blocked > 0 ? 'warn' : undefined}
          />
        </div>
      )}
    </SectionShell>
  );
}

function statusName(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ');
}

export function MoneySections({
  billing,
  usage,
  retryHref,
  gapFixHref,
}: {
  billing: Section<AnalyticsBillingCounts> | undefined;
  usage: Section<AnalyticsUsage> | undefined;
  retryHref: string;
  gapFixHref?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionShell gapFixHref={gapFixHref} title="Plans" description="Live subscriptions by plan and status, now. Amounts are on Billing > Overview." section={billing} retryHref={retryHref}>
        {(b) => {
          const total = b.plans.reduce((n, p) => n + p.count, 0);
          const t = b.trialConversion;
          return (
            <div className="space-y-4">
              <Bars
                title="Subscriptions by plan"
                b={{
                  rows: b.plans.map((p) => ({ key: `${p.planId}:${p.status}`, count: p.count, share: total ? p.count / total : 0 })),
                  other: 0,
                  unknown: 0,
                  total,
                }}
                name={(k) => {
                  const p = b.plans.find((x) => `${x.planId}:${x.status}` === k);
                  return p ? `${p.planName} · ${statusName(p.status)}` : k;
                }}
                empty="No live subscriptions."
              />
              <p className="text-sm text-[var(--color-muted-fg)]">
                Trial conversion:{' '}
                <span className="font-medium text-[var(--color-fg)]">{t.rate === null ? 'n/a' : formatShare(t.rate)}</span> (
                {formatCount(t.converted)} of {formatCount(t.ended)} trials that ended in range are active now)
              </p>
            </div>
          );
        }}
      </SectionShell>
      <SectionShell gapFixHref={gapFixHref} title="Top usage meters" description="Units recorded per meter." section={usage} retryHref={retryHref}>
        {(u) => {
          const total = u.meters.reduce((s, m) => s + m.units, 0);
          return (
            <div className="space-y-2">
              <p className="text-xs text-[var(--color-muted-fg)]">
                {formatDate(u.from)} to {formatDate(u.to)}
                {u.partial ? ': fewer days than the range, until the daily history covers it.' : '.'}
              </p>
              <Bars
                title="Top usage meters"
                b={{
                  rows: u.meters.map((m) => ({ key: m.meterId, count: m.units, share: total ? m.units / total : 0 })),
                  other: 0,
                  unknown: 0,
                  total,
                }}
                name={(k) => {
                  const m = u.meters.find((x) => x.meterId === k);
                  return m ? `${m.name}${m.unit ? ` (${m.unit})` : ''}` : k;
                }}
                empty="No usage recorded."
              />
            </div>
          );
        }}
      </SectionShell>
    </div>
  );
}

/** A date `days` before today, UTC. */
function daysAgo(days: number, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  return d.toISOString().slice(0, 10);
}

/**
 * Links into End-users rather than inline tables: rows would cost more
 * requests per view, and the list is where people are acted on anyway.
 */
export function PeopleLinks({ endUsersHref }: { endUsersHref: string | null }): React.JSX.Element | null {
  if (!endUsersHref) return null;
  const links = [
    { href: `${endUsersHref}?sort=lastActiveOn&order=desc`, title: 'Recently active', body: 'Most recently active first.' },
    { href: `${endUsersHref}?sort=createdAt&order=desc`, title: 'New sign-ups', body: 'Newest accounts first.' },
    {
      href: `${endUsersHref}?activeFrom=${daysAgo(60)}&inactiveForDays=14&minSignIns=2&sort=lastActiveOn&order=desc`,
      title: 'At risk',
      body: 'Came back at least twice, active in the last 60 days, quiet for 14.',
    },
  ];
  return (
    <section aria-label="People" className="space-y-3">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">People</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {links.map((l) => (
          <Link
            key={l.title}
            href={l.href}
            className="group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 transition-colors hover:border-[var(--color-faint-fg)]"
          >
            <p className="flex items-center justify-between text-sm font-medium text-[var(--color-fg)]">
              {l.title}
              <span aria-hidden="true" className="text-[var(--color-faint-fg)] group-hover:text-[var(--color-fg)]">
                →
              </span>
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">{l.body}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
