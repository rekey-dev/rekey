/**
 * Users > Overview: who uses this application, how often, and how they got
 * here. Aggregates only; per-person detail stays on End-users.
 *
 * Two API calls, in parallel, each behind its own Suspense boundary so the
 * top of the page paints while the heavier sections are still computing.
 * With the application read this page costs three requests.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { getApplication } from '@/lib/api';
import { hasScope } from '@/lib/operator-scopes';
import { SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { formatDate, formatRelative } from '@/lib/date';
import { isUnnarrowed, parseUsersQuery, usersHref, withoutFilters, type UsersFilters, type UsersView } from '@/lib/users-filters';
import {
  REST_SECTIONS,
  SECTION_SCOPE,
  TOP_SECTIONS,
  getUsersAnalytics,
  needsLivePath,
  type SectionName,
  type UsersAnalytics,
} from '@/lib/users-analytics';
import { FilterBar } from './filter-bar';
import { KpiRow, ActivitySection } from './top-sections';
import { RestSkeleton, TopSkeleton } from './skeletons';
import { MixSection, MoneySections, OnboardingSection, PeopleLinks, RetentionSection, SecuritySection } from './rest-sections';

export default async function UsersOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const app = await getApplication(id);
  const scopes = app.access?.scopes ?? null;

  if (!hasScope(scopes, 'overview:read')) {
    return (
      <EmptyState
        variant="inline"
        title="Users overview is not visible to your role"
        description="It needs the Overview scope on this application. End-users is still open to you if your access includes it."
      />
    );
  }

  const { filters, view, ignored } = parseUsersQuery(sp, scopes);
  const endUsersHref = hasScope(scopes, 'end-users:read') ? `/applications/${id}/end-users` : null;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Users overview"
        description="How many people use this application, how often they come back, and how they got here."
      />
      <FilterBar
        appId={id}
        filters={filters}
        view={view}
        canFilterPlan={hasScope(scopes, 'billing:read')}
        canFilterOrg={hasScope(scopes, 'organizations:read')}
      />
      {ignored.length > 0 && (
        <Banner tone="info">
          Ignored {ignored.length === 1 ? 'filter' : 'filters'}:{' '}
          {ignored.map((i) => `${i.param} (${i.reason})`).join('; ')}.
        </Banner>
      )}
      <React.Suspense key={`top:${usersHref(id, filters, view)}`} fallback={<TopSkeleton />}>
        <TopHalf appId={id} filters={filters} view={view} endUsersHref={endUsersHref} />
      </React.Suspense>
      <React.Suspense key={`rest:${usersHref(id, filters, view)}`} fallback={<RestSkeleton />}>
        <RestHalf
          appId={id}
          filters={filters}
          view={view}
          scopes={scopes}
          endUsersHref={endUsersHref}
        />
      </React.Suspense>
    </div>
  );
}

async function TopHalf({
  appId,
  filters,
  view,
  endUsersHref,
}: {
  appId: string;
  filters: UsersFilters;
  view: UsersView;
  endUsersHref: string | null;
}): Promise<React.JSX.Element> {
  const result = await getUsersAnalytics(appId, filters, TOP_SECTIONS);
  if (result.kind === 'not_served') {
    return (
      <EmptyState
        title="This API does not serve the Users overview yet"
        description="The panel is newer than the API it talks to. Upgrade the API to the same release; until then, End-users has the per-person view."
        action={
          endUsersHref ? (
            <Link
              href={endUsersHref}
              className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
            >
              Open End-users
            </Link>
          ) : undefined
        }
      />
    );
  }
  if (result.kind === 'refused') {
    return (
      <Banner tone="error">
        <strong className="font-medium">{result.message}</strong>
        {result.fix ? ` ${result.fix}` : ''}
        {result.code === 'ANALYTICS_RANGE_TOO_LONG' && needsLivePath(filters) && (
          <>
            {' '}
            <Link href={usersHref(appId, { ...filters, range: '30d' }, view)} className="font-medium underline underline-offset-2">
              Show the last 30 days with these filters
            </Link>
          </>
        )}
      </Banner>
    );
  }
  const data = result.data;
  const retryHref = usersHref(appId, filters, view);
  const kpis = data.sections.kpis;
  const gapFixHref = shortRangeHref(appId, filters, view);

  const nobody = kpis?.status === 'ok' && kpis.data.totalUsers.value === 0;
  if (nobody && isUnnarrowed(filters)) {
    return (
      <EmptyState
        title="No users yet"
        description="Numbers appear here once people sign up. Mint an API key and follow the quick start on the Overview tab to wire up sign-in."
        action={
          <Link
            href={`/applications/${appId}`}
            className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
          >
            Go to quick start
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      {nobody && (
        <Banner tone="info">
          No users match these filters.{' '}
          <Link href={usersHref(appId, withoutFilters(filters), view)} className="font-medium underline underline-offset-2">
            Clear filters
          </Link>
        </Banner>
      )}
      <RangeLine data={data} />
      <KpiRow section={kpis} retryHref={retryHref} endUsersHref={endUsersHref} gapFixHref={gapFixHref} />
      <ActivitySection
        section={data.sections.activity}
        analytics={data}
        appId={appId}
        filters={filters}
        view={view}
        retryHref={retryHref}
        gapFixHref={gapFixHref}
        stickiness={kpis?.status === 'ok' ? kpis.data.stickiness : null}
      />
    </div>
  );
}

/**
 * Everything below the activity charts. Sections the caller has no scope for
 * are not requested; they render as "Not visible to your role" without a
 * round trip.
 */
async function RestHalf({
  appId,
  filters,
  view,
  scopes,
  endUsersHref,
}: {
  appId: string;
  filters: UsersFilters;
  view: UsersView;
  scopes: string[] | null;
  endUsersHref: string | null;
}): Promise<React.JSX.Element | null> {
  const allowed = (s: SectionName): boolean => {
    const need = SECTION_SCOPE[s];
    return need === undefined || hasScope(scopes, need);
  };
  const wanted = REST_SECTIONS.filter(allowed);
  const result = await getUsersAnalytics(appId, filters, wanted, view.field);
  // The top half already explains an older API.
  if (result.kind === 'not_served') return null;
  if (result.kind === 'refused') {
    return (
      <Banner tone="error">
        The lower sections could not be loaded: <strong className="font-medium">{result.message}</strong>
        {result.fix ? ` ${result.fix}` : ''}
      </Banner>
    );
  }
  const data = result.data;
  const sections = { ...data.sections };
  for (const s of REST_SECTIONS) {
    if (!allowed(s)) sections[s] = { status: 'forbidden', scope: SECTION_SCOPE[s]! };
  }
  const onboarding = data.sections.onboarding;
  // No users at all, and nothing narrowing the view: the top half shows the
  // page's one empty state. Under a filter the sections stay, zeros and all.
  if (isUnnarrowed(filters) && onboarding?.status === 'ok' && onboarding.data.counts.total === 0) return null;
  const retryHref = usersHref(appId, filters, view);
  const gapFixHref = shortRangeHref(appId, filters, view);
  const tab = (seg: string, scope: Parameters<typeof hasScope>[1]): string | null =>
    hasScope(scopes, scope) ? `/applications/${appId}/${seg}` : null;

  return (
    <div className="space-y-6">
      <MixSection gapFixHref={gapFixHref} section={sections.mix} retryHref={retryHref} />
      <OnboardingSection
        gapFixHref={gapFixHref}
        section={sections.onboarding}
        retryHref={retryHref}
        appId={appId}
        filters={filters}
        view={view}
        onboardingHref={tab('onboarding', 'end-users:read')}
        canPickQuestion={hasScope(scopes, 'end-users:read')}
      />
      <RetentionSection gapFixHref={gapFixHref} section={sections.retention} retryHref={retryHref} />
      <SecuritySection gapFixHref={gapFixHref} section={sections.security} retryHref={retryHref} activityHref={tab('activity', 'activity:read')} />
      <MoneySections gapFixHref={gapFixHref} billing={sections.billing} usage={sections.usage} retryHref={retryHref} />
      <PeopleLinks endUsersHref={endUsersHref} />
    </div>
  );
}

/** The same view over the last 30 days, or nothing when the range is already that short. */
function shortRangeHref(appId: string, filters: UsersFilters, view: UsersView): string | undefined {
  if (filters.range === '7d' || filters.range === '30d') return undefined;
  const { from: _from, to: _to, ...rest } = filters;
  return usersHref(appId, { ...rest, range: '30d' }, view);
}

function RangeLine({ data }: { data: UsersAnalytics }): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-muted-fg)]">
      <span>
        {formatDate(data.range.from)} to {formatDate(data.range.to)}
        {data.range.compare && `, compared with ${formatDate(data.range.compare.from)} to ${formatDate(data.range.compare.to)}`}
      </span>
      <span aria-hidden="true">·</span>
      <span>{data.range.timezone} days</span>
      <span aria-hidden="true">·</span>
      <span title={data.asOf}>Updated {formatRelative(data.asOf)}</span>
    </p>
  );
}
