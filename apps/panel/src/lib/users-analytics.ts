/**
 * Client for `GET /tenant/applications/:id/analytics/users`. The shapes are
 * the API's own, from `@rekey.dev/shared-types`; this file only narrows each
 * section envelope to its data type.
 *
 * The page asks twice, in parallel: the top of the page (KPIs and activity)
 * and the rest, each streamed through its own Suspense boundary. Every
 * section arrives in its own envelope, so one failing section never blanks
 * the others.
 *
 * Server-only: it goes through `lib/api.ts`.
 */

import type {
  AnalyticsActivity,
  AnalyticsBillingCounts,
  AnalyticsKpis,
  AnalyticsMetric,
  AnalyticsMix,
  AnalyticsOnboarding,
  AnalyticsRetention,
  AnalyticsSection,
  AnalyticsSectionEnvelope,
  AnalyticsSecurity,
  AnalyticsUsage,
  AnalyticsUsersResponse,
} from '@rekey.dev/shared-types';
import { api, PanelApiError } from '@/lib/api';
import type { Scope } from '@/lib/operator-scopes';
import { effectiveFilters, filterParams, type UsersFilters } from '@/lib/users-filters';

export const TOP_SECTIONS = ['kpis', 'activity'] as const satisfies readonly AnalyticsSection[];
export const REST_SECTIONS = [
  'mix',
  'onboarding',
  'retention',
  'security',
  'billing',
  'usage',
] as const satisfies readonly AnalyticsSection[];
export type SectionName = AnalyticsSection;

/** The scope each section needs beyond the route's own `overview:read`. */
export const SECTION_SCOPE: Partial<Record<SectionName, Scope>> = {
  billing: 'billing:read',
  usage: 'billing:read',
};

export interface SectionDataMap {
  kpis: AnalyticsKpis;
  activity: AnalyticsActivity;
  mix: AnalyticsMix;
  onboarding: AnalyticsOnboarding;
  retention: AnalyticsRetention;
  security: AnalyticsSecurity;
  billing: AnalyticsBillingCounts;
  usage: AnalyticsUsage;
}

export type Section<T> = AnalyticsSectionEnvelope<T>;

/** The response with each section narrowed to its own data type. */
export type UsersAnalytics = Omit<AnalyticsUsersResponse, 'sections'> & {
  sections: { [K in SectionName]?: Section<SectionDataMap[K]> };
};

export type UsersAnalyticsResult =
  | { kind: 'ok'; data: UsersAnalytics }
  /** The API predates the route. The page says so and points at End-users. */
  | { kind: 'not_served' }
  /** The request as a whole was refused (a range too long, a filter it does not support). */
  | { kind: 'refused'; code: string; message: string; fix: string | undefined };

const STATUSES = new Set(['ok', 'error', 'forbidden', 'pending', 'unavailable']);

/**
 * True when a section envelope has the shape this panel knows. A section in a
 * shape it does not know renders as an error rather than crashing the page.
 */
export function isSection(x: unknown): x is Section<unknown> {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as { status?: unknown; data?: unknown };
  if (typeof s.status !== 'string' || !STATUSES.has(s.status)) return false;
  return s.status !== 'ok' || (typeof s.data === 'object' && s.data !== null);
}

export function analyticsPath(appId: string, filters: UsersFilters, sections: readonly SectionName[], field?: string): string {
  const q = new URLSearchParams(filterParams(effectiveFilters(filters)));
  q.set('sections', [...sections].join(','));
  if (field) q.set('profileField', field);
  return `/api/v1/tenant/applications/${encodeURIComponent(appId)}/analytics/users?${q.toString()}`;
}

/**
 * One call for a set of sections. Anything but a refusal or a missing route
 * is rethrown, so a busy API (429/503) reaches the busy notice.
 */
export async function getUsersAnalytics(
  appId: string,
  filters: UsersFilters,
  sections: readonly SectionName[],
  field?: string,
): Promise<UsersAnalyticsResult> {
  try {
    const data = await api<UsersAnalytics>({
      method: 'GET',
      path: analyticsPath(appId, filters, sections, field),
      interruptOnAccessError: false,
    });
    return { kind: 'ok', data };
  } catch (err) {
    if (err instanceof PanelApiError) {
      if (err.statusCode === 404 && err.code === 'ROUTE_NOT_FOUND') return { kind: 'not_served' };
      if (err.statusCode === 400 || err.statusCode === 403) {
        return { kind: 'refused', code: err.code, message: err.message, fix: err.fix };
      }
    }
    throw err;
  }
}

export type Polarity = 'up_is_good' | 'down_is_good' | 'neutral';

/**
 * A metric's change as the tile shows it: percent for counts, points for
 * rates. Null when either period has no value to compare.
 */
export function describeDelta(
  m: Pick<AnalyticsMetric, 'value' | 'previous'>,
  kind: 'count' | 'rate',
  polarity: Polarity = 'up_is_good',
): { text: string; direction: 'up' | 'down' | 'flat'; good: boolean | null; reason?: string } | null {
  if (m.previous === null || m.value === null) return null;
  const diff = m.value - m.previous;
  const direction = Math.abs(diff) < 1e-9 ? 'flat' : diff > 0 ? 'up' : 'down';
  const good = polarity === 'neutral' || direction === 'flat' ? null : (direction === 'up') === (polarity === 'up_is_good');
  if (kind === 'rate') {
    const pts = Math.abs(diff * 100);
    return { text: `${pts.toFixed(1)} pt`, direction, good };
  }
  if (m.previous === 0) {
    return diff === 0 ? { text: '0%', direction: 'flat', good: null } : { text: 'new', direction, good, reason: 'Nothing in the previous period' };
  }
  const pct = Math.abs((diff / m.previous) * 100);
  return { text: `${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`, direction, good };
}

const LIVE_ONLY_FILTERS = ['plan', 'paying', 'org', 'onboarding', 'verified', 'mfa'] as const;
const DIMENSIONS = ['platform', 'country', 'via', 'createdVia'] as const;

/**
 * Whether these filters can only be answered from live data, which covers the
 * last 63 days: any population filter, or two dimensions at once. The daily
 * rollup keeps one dimension at a time.
 */
export function needsLivePath(f: UsersFilters): boolean {
  if (LIVE_ONLY_FILTERS.some((k) => f[k] !== undefined)) return true;
  return DIMENSIONS.filter((k) => f[k].length > 0).length >= 2;
}
