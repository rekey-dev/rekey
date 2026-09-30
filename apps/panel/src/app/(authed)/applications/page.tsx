import * as React from 'react';
import { api, getMe, readErrorFlash, unlessBusy, type ApplicationRow } from '@/lib/api';
import { Pager, readPageSize } from '@/components/Pager';
import type { Page } from '@/lib/paginate';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { OnboardingChecklist } from '@/components/OnboardingChecklist';
import { ReadyToGoLive } from '@/components/ReadyToGoLive';
import { FilterChips } from '@/components/FilterChips';
import { NewAppModal } from './new-app';
import { buildOnboardingSteps } from './onboarding-steps';
import { AppList } from './app-list';
import { SubmitOnChangeSelect } from './submit-on-change';
import {
  APP_SORTS,
  SORT_LABEL,
  appListApiQuery,
  appListHref,
  appListParams,
  isFiltered,
  readAppListFilters,
  type AppListFilters,
} from './filters';

const LIST_PATH = '/api/v1/tenant/applications/';

/** Past this many running applications the list is the job, and the checklist moves below it. */
const CHECKLIST_ON_TOP_UP_TO = 2;

const controlCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function Toolbar({ filters, disabledCount }: { filters: AppListFilters; disabledCount: number | null }): React.JSX.Element {
  const hidden = appListParams({ ...filters, q: '', sort: 'created' });
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <form
        key={JSON.stringify(filters)}
        action="/applications"
        role="search"
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label htmlFor="app-search" className="sr-only">
          Search applications
        </label>
        <input
          id="app-search"
          type="search"
          name="q"
          defaultValue={filters.q}
          maxLength={80}
          placeholder="Search by name or slug"
          className={`${controlCls} w-full sm:w-64`}
        />
        <label className="flex items-center gap-2 text-xs text-[var(--color-muted-fg)]">
          <span className="shrink-0">Sort</span>
          <SubmitOnChangeSelect name="sort" defaultValue={filters.sort} className={`${controlCls} w-full sm:w-auto`}>
            {APP_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </SubmitOnChangeSelect>
        </label>
        <button type="submit" className="sr-only">
          Apply
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <FilterChips
          label="Environment"
          active={filters.environment}
          hrefFor={(v) => appListHref(filters, { environment: v as AppListFilters['environment'] })}
          chips={[
            { value: undefined, label: 'All' },
            { value: 'PRODUCTION', label: 'Production' },
            { value: 'STAGING', label: 'Staging' },
            { value: 'DEVELOPMENT', label: 'Development' },
          ]}
        />
        {(filters.showDisabled || disabledCount !== 0) && (
          <a
            href={appListHref(filters, { showDisabled: !filters.showDisabled })}
            aria-current={filters.showDisabled ? 'true' : undefined}
            className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
              filters.showDisabled
                ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] font-medium text-[var(--color-fg)]'
                : 'border-[var(--color-border)] text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid size-3.5 place-items-center rounded-[3px] border text-[9px] leading-none ${
                filters.showDisabled
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                  : 'border-[var(--color-border)]'
              }`}
            >
              {filters.showDisabled ? '✓' : ''}
            </span>
            Show disabled{disabledCount !== null && <span className="tabular-nums">({disabledCount})</span>}
          </a>
        )}
      </div>
    </div>
  );
}

function describeFilters(f: AppListFilters): string {
  const env = f.environment ? `${f.environment.toLowerCase()} ` : '';
  return f.q ? `No ${env}application has “${f.q}” in its name or slug.` : `There are no ${env}applications.`;
}

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for a failed create, left by `errorQuery`
  // in a short-lived httpOnly cookie rather than the URL.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  // Only owners and admins may create an Application. A MEMBER starts with
  // access to none, so their empty list means "nothing shared yet", and the
  // create button and the setup checklist would only lead them to a 403.
  const me = await getMe().catch(() => null);
  const canManageApps = me === null || me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';

  const filters = readAppListFilters(sp);
  const filtered = isFiltered(filters);
  const pageSize = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const [list, disabledCount] = await Promise.all([
    api<Page<ApplicationRow>>({
      method: 'GET',
      path: `${LIST_PATH}?${appListApiQuery(filters, { limit: pageSize, offset }, filters.showDisabled ? undefined : 'active')}&include=summary`,
    }),
    // The count behind "Show disabled (N)", under the same search and
    // environment. A failure hides the number, never the toggle once it is on.
    api<Page<ApplicationRow>>({
      method: 'GET',
      path: `${LIST_PATH}?${appListApiQuery(filters, { limit: 1, offset: 0 }, 'disabled')}`,
    })
      .then((p) => p.page.total)
      .catch(unlessBusy(() => null)),
  ]);
  const apps = list.items;
  const total = list.page.total;
  const running = apps.filter((a) => !a.disabledAt);
  // An unread disabled count is not a zero: in a workspace whose every
  // application is disabled, reading it as zero would offer to create a first
  // application to someone who has several.
  const workspaceHasApps = total > 0 || disabledCount !== 0 || filtered;

  // The checklist describes the whole workspace, so it only appears on the
  // unfiltered first page, where the rows it reads are the workspace's own.
  // A workspace whose every application is disabled has nothing to set up.
  const onboarding =
    offset === 0 && canManageApps && !filtered && (running.length > 0 || !workspaceHasApps)
      ? await buildOnboardingSteps(running)
      : null;
  const firstRunning = running[0];
  const setup = onboarding ? (
    onboarding.allDone ? (
      firstRunning && (
        <ReadyToGoLive
          storageKey={`rekey.ready.dismissed.${onboarding.tenantId}`}
          links={[
            {
              label: 'Quick start',
              description: 'The app overview walks through wiring the SDK into your backend.',
              href: `/applications/${firstRunning.id}`,
            },
            {
              label: 'API keys',
              description: 'Keys inherit the application’s environment, check you are on the right one.',
              href: `/applications/${firstRunning.id}/api-keys`,
            },
            {
              label: 'Billing providers',
              description: 'A production application needs your provider’s live credentials.',
              href: `/applications/${firstRunning.id}/billing`,
            },
          ]}
        />
      )
    ) : (
      <OnboardingChecklist steps={onboarding.steps} storageKey={`rekey.onboarding.dismissed.${onboarding.tenantId}`} />
    )
  ) : null;
  const setupOnTop = total <= CHECKLIST_ON_TOP_UP_TO;

  const newApp = (props: { triggerLabel?: string; triggerSize?: 'sm' | 'md' }): React.JSX.Element => (
    <NewAppModal error={error} errorDetail={errorDetail} errorFix={errorFix} modalKey="newApp" {...props} />
  );

  let body: React.ReactNode;
  if (!workspaceHasApps && !canManageApps) {
    body = (
      <EmptyState
        title="No applications shared with you yet"
        description={
          <>
            You&apos;re a <strong>member</strong> of this workspace. Members only see the applications they have been
            granted access to, and you don&apos;t have any yet. Ask an owner or admin to grant you access under{' '}
            <strong>Team → Application access</strong>.
          </>
        }
      />
    );
  } else if (!workspaceHasApps) {
    body = (
      <EmptyState
        title="No applications yet"
        description={
          <>
            An application is one product&apos;s end-users, sign-in settings, API keys and, if you want it, billing.
            Most teams make one per environment, such as <code>acme-prod</code> and <code>acme-dev</code>.
          </>
        }
        action={newApp({ triggerLabel: 'Create your first application', triggerSize: 'md' })}
      />
    );
  } else if (apps.length === 0 && total === 0 && !filtered && !filters.showDisabled) {
    body = (
      <EmptyState
        title={disabledCount === null
            ? 'No running applications to show'
            : disabledCount === 1
              ? 'Your only application is disabled'
              : `All ${disabledCount} applications are disabled`}
        description={
          disabledCount === null
            ? 'The number of disabled applications could not be read. Show them to check.'
            : 'A disabled application refuses end-user traffic but keeps all its data. Show them to review or re-enable one.'
        }
        action={
          <a
            href={appListHref(filters, { showDisabled: true })}
            className="inline-block rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
          >
            Show disabled applications
          </a>
        }
      />
    );
  } else if (total === 0) {
    const hiddenMatches = !filters.showDisabled && (disabledCount ?? 0) > 0;
    body = (
      <EmptyState
        title="No applications match these filters"
        description={
          <>
            {describeFilters(filters)}
            {hiddenMatches && (
              <>
                {' '}
                {disabledCount} disabled {disabledCount === 1 ? 'one matches' : 'ones match'}, and they are hidden.
              </>
            )}
          </>
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <a
              href={appListHref({ q: '', environment: undefined, sort: filters.sort, showDisabled: filters.showDisabled })}
              className="inline-block rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
            >
              Clear filters
            </a>
            {hiddenMatches && (
              <a
                href={appListHref(filters, { showDisabled: true })}
                className="inline-block rounded-md px-3 py-1.5 text-sm text-[var(--color-primary)] hover:underline"
              >
                Show disabled
              </a>
            )}
          </div>
        }
      />
    );
  } else {
    body = <AppList apps={apps} />;
  }

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Applications"
        description="Each application has its own end-users, API keys, sign-in settings and, optionally, billing."
        // The empty state carries its own create button; two triggers on one
        // modalKey would open the dialog twice.
        action={workspaceHasApps && canManageApps ? newApp({}) : undefined}
      />

      {setupOnTop && setup}

      {workspaceHasApps && (
        <div className="space-y-3">
          <Toolbar filters={filters} disabledCount={disabledCount} />
          {total > 0 && (
            <p className="text-xs text-[var(--color-muted-fg)]" aria-live="polite">
              <span className="tabular-nums">{total}</span> {filtered ? (total === 1 ? 'match' : 'matches') : total === 1 ? 'application' : 'applications'}
              {!filters.showDisabled && (disabledCount ?? 0) > 0 && !filtered && (
                <>, {disabledCount} disabled hidden</>
              )}
              {filtered && (
                <>
                  {' · '}
                  <a
                    href={appListHref({ q: '', environment: undefined, sort: filters.sort, showDisabled: filters.showDisabled })}
                    className="underline hover:text-[var(--color-fg)]"
                  >
                    Clear filters
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}

      {body}

      <Pager
        basePath="/applications"
        offset={offset}
        pageSize={pageSize}
        count={apps.length}
        hasMore={list.page.hasMore}
        extraParams={appListParams(filters)}
      />

      {!setupOnTop && setup}
    </section>
  );
}
