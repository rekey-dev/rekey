import type { ApplicationRow } from '@/lib/api';

export const APP_SORTS = ['created', 'name', 'activity'] as const;
export type AppSort = (typeof APP_SORTS)[number];

export const SORT_LABEL: Record<AppSort, string> = {
  created: 'Newest first',
  name: 'Name, A to Z',
  activity: 'Recently active',
};

export type AppEnvironmentFilter = ApplicationRow['environment'];

/**
 * What the Applications list is narrowed to, read from and written back to
 * the URL so a filtered view can be shared, bookmarked and reloaded.
 * Disabled applications are hidden unless `showDisabled` is on.
 */
export interface AppListFilters {
  q: string;
  environment: AppEnvironmentFilter | undefined;
  sort: AppSort;
  showDisabled: boolean;
}

type SearchParams = Record<string, string | string[] | undefined>;

const ENVIRONMENTS: readonly AppEnvironmentFilter[] = ['PRODUCTION', 'STAGING', 'DEVELOPMENT'];

function one(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * @example
 * readAppListFilters({ env: 'PRODUCTION', disabled: '1' })
 * // { q: '', environment: 'PRODUCTION', sort: 'created', showDisabled: true }
 */
export function readAppListFilters(sp: SearchParams): AppListFilters {
  const env = one(sp, 'env')?.toUpperCase();
  const sort = one(sp, 'sort');
  return {
    q: (one(sp, 'q') ?? '').trim().slice(0, 80),
    environment: ENVIRONMENTS.find((e) => e === env),
    sort: APP_SORTS.find((s) => s === sort) ?? 'created',
    showDisabled: one(sp, 'disabled') === '1',
  };
}

/** True when anything narrows the list, which is when "no results" means the filters, not the workspace. */
export function isFiltered(f: AppListFilters): boolean {
  return f.q !== '' || f.environment !== undefined;
}

/** The URL params for a filter state, leaving defaults out so the plain URL stays plain. */
export function appListParams(f: AppListFilters): Record<string, string> {
  return {
    ...(f.q && { q: f.q }),
    ...(f.environment && { env: f.environment }),
    ...(f.sort !== 'created' && { sort: f.sort }),
    ...(f.showDisabled && { disabled: '1' }),
  };
}

/**
 * The page URL for a filter state with some fields changed. Paging restarts,
 * because the old offset points into a different result set.
 *
 * @example
 * appListHref(filters, { environment: undefined }) // "/applications?q=web"
 */
export function appListHref(f: AppListFilters, change: Partial<AppListFilters> = {}): string {
  const qs = new URLSearchParams(appListParams({ ...f, ...change })).toString();
  return `/applications${qs ? `?${qs}` : ''}`;
}

/** The API query for one page of the list. */
export function appListApiQuery(
  f: AppListFilters,
  page: { limit: number; offset: number },
  status: 'active' | 'disabled' | undefined,
): string {
  const p = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset), sort: f.sort });
  if (status) p.set('status', status);
  if (f.environment) p.set('environment', f.environment);
  if (f.q) p.set('q', f.q);
  return p.toString();
}
