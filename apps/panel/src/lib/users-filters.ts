/**
 * The Users overview's filters, read from and written back to the URL, so a
 * view is shareable and bookmarkable. Values are enums or opaque ids, never
 * emails: page views, query string included, go to analytics.
 *
 * Pure, so it is unit-tested directly.
 */

import {
  ANALYTICS_ONBOARDING,
  ANALYTICS_RANGE_PRESETS,
  CLIENT_PLATFORMS,
  CREATED_VIA_KINDS,
  CREATED_VIA_PATTERN,
  SIGN_IN_VIAS,
  type AnalyticsRangePreset,
} from '@rekey.dev/shared-types';
import { hasScope } from '@/lib/operator-scopes';

export const RANGE_PRESETS = ANALYTICS_RANGE_PRESETS;
export type RangePreset = AnalyticsRangePreset;

export const PLATFORMS = CLIENT_PLATFORMS;
export const SIGN_IN_METHODS = SIGN_IN_VIAS;
export const ONBOARDING_STATES = ANALYTICS_ONBOARDING;
/** The sign-up sources the filter dialog offers; `oauth` matches every provider. */
export const CREATED_VIA_OPTIONS = CREATED_VIA_KINDS;
export const ACTIVITY_METRICS = ['dau', 'wau', 'mau'] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

export const RANGE_LABEL: Record<RangePreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12m': 'Last 12 months',
  custom: 'Custom range',
};

export interface UsersFilters {
  range: RangePreset;
  /** Only for `custom`: YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  compare: 'prev' | 'none';
  platform: string[];
  country: string[];
  via: string[];
  /** Sign-up source: a kind (`oauth` matches every provider) or `oauth:<provider>`; `unknown` is none recorded. */
  createdVia: string[];
  onboarding?: (typeof ONBOARDING_STATES)[number];
  verified?: boolean;
  mfa?: boolean;
  plan?: string;
  paying?: boolean;
  org?: string;
}

/** Page state that is not a filter: which chart line, which profile field. */
export interface UsersView {
  metric: ActivityMetric;
  field?: string;
}

export interface ParsedUsersQuery {
  filters: UsersFilters;
  view: UsersView;
  /** Params the page dropped, with why, for the "Ignored filter" note. */
  ignored: Array<{ param: string; reason: string }>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const COUNTRY = /^[A-Z]{2}$/;
const MAX_COUNTRIES = 10;
const VIEW_PARAMS = new Set(['metric', 'field']);

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function list(v: string | undefined): string[] {
  return v ? [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))] : [];
}

function validDate(s: string | undefined): s is string {
  if (!s || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function bool(v: string | undefined): boolean | undefined {
  return v === 'true' ? true : v === 'false' ? false : undefined;
}

/**
 * Read the page's query string. Anything unknown or malformed is dropped and
 * reported, never passed on to the API. `plan`, `paying` and `org` are dropped
 * for a caller without the scope they need, since the API would refuse them.
 */
export function parseUsersQuery(
  sp: Record<string, string | string[] | undefined>,
  scopes: readonly string[] | null,
): ParsedUsersQuery {
  const ignored: ParsedUsersQuery['ignored'] = [];
  const bad = (param: string, reason: string): void => {
    ignored.push({ param, reason });
  };
  const get = (k: string): string | undefined => {
    const v = first(sp[k]);
    return v === '' ? undefined : v;
  };
  const getList = (k: string): string | undefined => {
    const v = sp[k];
    const joined = Array.isArray(v) ? v.join(',') : v;
    return joined === '' ? undefined : joined;
  };

  const known = new Set([
    'range',
    'from',
    'to',
    'compare',
    'platform',
    'country',
    'via',
    'createdVia',
    'onboarding',
    'verified',
    'mfa',
    'plan',
    'paying',
    'org',
    ...VIEW_PARAMS,
  ]);
  for (const k of Object.keys(sp)) if (!known.has(k)) bad(k, 'not a filter on this page');

  let range: RangePreset = '30d';
  const r = get('range');
  if (r !== undefined) {
    if ((RANGE_PRESETS as readonly string[]).includes(r)) range = r as RangePreset;
    else bad('range', `use one of ${RANGE_PRESETS.join(', ')}`);
  }
  const filters: UsersFilters = { range, compare: get('compare') === 'none' ? 'none' : 'prev', platform: [], country: [], via: [], createdVia: [] };
  if (get('compare') !== undefined && !['prev', 'none'].includes(get('compare')!)) bad('compare', 'use prev or none');

  if (range === 'custom') {
    const from = get('from');
    const to = get('to');
    if (validDate(from) && validDate(to) && from <= to) {
      filters.from = from;
      filters.to = to;
    } else if (from !== undefined || to !== undefined) {
      // Stays custom, so the date inputs render for a correction; the API is
      // asked for the last 30 days until both dates are valid.
      bad('from', 'a custom range needs from and to as YYYY-MM-DD, from on or before to');
    }
  } else {
    if (get('from') !== undefined) bad('from', 'only used with a custom range');
    if (get('to') !== undefined) bad('to', 'only used with a custom range');
  }

  for (const p of list(getList('platform'))) {
    if ((PLATFORMS as readonly string[]).includes(p)) filters.platform.push(p);
    else bad('platform', `unknown platform "${p}"`);
  }
  const countries = list(getList('country')).map((c) => c.toUpperCase());
  for (const c of countries) {
    if (!COUNTRY.test(c)) bad('country', `"${c}" is not a two-letter country code`);
    else if (filters.country.length >= MAX_COUNTRIES) bad('country', `at most ${MAX_COUNTRIES} countries`);
    else filters.country.push(c);
  }
  for (const v of list(getList('via'))) {
    if ((SIGN_IN_METHODS as readonly string[]).includes(v)) filters.via.push(v);
    else bad('via', `unknown sign-in method "${v}"`);
  }

  for (const c of list(getList('createdVia'))) {
    if (!CREATED_VIA_PATTERN.test(c)) bad('createdVia', `unknown sign-up source "${c}"`);
    else if (filters.createdVia.length >= 10) bad('createdVia', 'at most 10 sources');
    else filters.createdVia.push(c);
  }

  const onboarding = get('onboarding');
  if (onboarding !== undefined) {
    if ((ONBOARDING_STATES as readonly string[]).includes(onboarding)) filters.onboarding = onboarding as UsersFilters['onboarding'];
    else bad('onboarding', 'use pending, completed or skipped');
  }
  for (const k of ['verified', 'mfa'] as const) {
    const raw = get(k);
    if (raw === undefined) continue;
    const b = bool(raw);
    if (b === undefined) bad(k, 'use true or false');
    else filters[k] = b;
  }

  const canBilling = hasScope(scopes, 'billing:read');
  const plan = get('plan');
  if (plan !== undefined) {
    if (!canBilling) bad('plan', 'needs billing read access');
    else if (!ID.test(plan)) bad('plan', 'not a plan id');
    else filters.plan = plan;
  }
  const paying = get('paying');
  if (paying !== undefined) {
    if (!canBilling) bad('paying', 'needs billing read access');
    else if (paying !== 'true') bad('paying', 'use true');
    else filters.paying = true;
  }
  const org = get('org');
  if (org !== undefined) {
    if (!hasScope(scopes, 'organizations:read')) bad('org', 'needs organizations read access');
    else if (!ID.test(org)) bad('org', 'not an organization id');
    else filters.org = org;
  }

  const metricRaw = get('metric');
  const metric = (ACTIVITY_METRICS as readonly string[]).includes(metricRaw ?? '') ? (metricRaw as ActivityMetric) : 'dau';
  if (metricRaw !== undefined && metric !== metricRaw) bad('metric', 'use dau, wau or mau');
  const field = get('field');
  const view: UsersView = { metric };
  if (field !== undefined) {
    // The API refuses the whole request for profile answers without it.
    if (!hasScope(scopes, 'end-users:read')) bad('field', 'needs end-users read access');
    else if (FIELD_KEY.test(field)) view.field = field;
    else bad('field', 'not a profile field key');
  }

  return { filters, view, ignored };
}

/**
 * The filters as the API should see them: a custom range without both dates
 * is asked for as the last 30 days, while the page keeps showing the date
 * inputs so the operator can finish choosing.
 */
export function effectiveFilters(f: UsersFilters): UsersFilters {
  if (f.range !== 'custom' || (f.from && f.to)) return f;
  const { from: _from, to: _to, ...rest } = f;
  return { ...rest, range: '30d' };
}

/** A default custom range: the 30 UTC days ending today. */
export function defaultCustomDates(now: Date = new Date()): { from: string; to: string } {
  const day = (offset: number): string =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)).toISOString().slice(0, 10);
  return { from: day(29), to: day(0) };
}

/** The same range and comparison with every narrowing filter removed. */
export function withoutFilters(f: UsersFilters): UsersFilters {
  return {
    range: f.range,
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
    compare: f.compare,
    platform: [],
    country: [],
    via: [],
    createdVia: [],
  };
}

/**
 * True when nothing narrows the population: no filter, and a range that ends
 * today. Only then does zero users mean the application has none.
 */
export function isUnnarrowed(f: UsersFilters, now: Date = new Date()): boolean {
  if (activeFilterCount(f) > 0) return false;
  return f.range !== 'custom' || !f.to || f.to >= defaultCustomDates(now).to;
}

/** How many narrowing filters are on (range and compare are not counted). */
export function activeFilterCount(f: UsersFilters): number {
  return (
    (f.platform.length ? 1 : 0) +
    (f.country.length ? 1 : 0) +
    (f.via.length ? 1 : 0) +
    (f.createdVia.length ? 1 : 0) +
    (f.onboarding ? 1 : 0) +
    (f.verified !== undefined ? 1 : 0) +
    (f.mfa !== undefined ? 1 : 0) +
    (f.plan ? 1 : 0) +
    (f.paying ? 1 : 0) +
    (f.org ? 1 : 0)
  );
}

/** The filters as query params, keys sorted, multi-values sorted: stable for sharing and caching. */
export function filterParams(f: UsersFilters): Array<[string, string]> {
  const out: Array<[string, string]> = [['range', f.range]];
  if (f.range === 'custom' && f.from && f.to) out.push(['from', f.from], ['to', f.to]);
  out.push(['compare', f.compare]);
  if (f.platform.length) out.push(['platform', [...f.platform].sort().join(',')]);
  if (f.country.length) out.push(['country', [...f.country].sort().join(',')]);
  if (f.via.length) out.push(['via', [...f.via].sort().join(',')]);
  if (f.createdVia.length) out.push(['createdVia', [...f.createdVia].sort().join(',')]);
  if (f.onboarding) out.push(['onboarding', f.onboarding]);
  if (f.verified !== undefined) out.push(['verified', String(f.verified)]);
  if (f.mfa !== undefined) out.push(['mfa', String(f.mfa)]);
  if (f.plan) out.push(['plan', f.plan]);
  if (f.paying) out.push(['paying', 'true']);
  if (f.org) out.push(['org', f.org]);
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** The page URL for a filter set and view; defaults are left out so links stay short. */
export function usersHref(appId: string, f: UsersFilters, view: Partial<UsersView> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of filterParams(f)) {
    if ((k === 'range' && v === '30d') || (k === 'compare' && v === 'prev')) continue;
    q.set(k, v);
  }
  if (view.metric && view.metric !== 'dau') q.set('metric', view.metric);
  if (view.field) q.set('field', view.field);
  const s = q.toString();
  return `/applications/${appId}/users${s ? `?${s}` : ''}`;
}

/** Each active filter as a chip: a label, and the filter set without it. */
export function filterChips(f: UsersFilters): Array<{ key: string; label: string; without: UsersFilters }> {
  const chips: Array<{ key: string; label: string; without: UsersFilters }> = [];
  const add = (key: string, label: string, without: Partial<UsersFilters>): void => {
    chips.push({ key, label, without: { ...f, ...without } });
  };
  if (f.platform.length) add('platform', `Platform: ${f.platform.map(platformName).join(', ')}`, { platform: [] });
  if (f.country.length) add('country', `Country: ${f.country.join(', ')}`, { country: [] });
  if (f.via.length) add('via', `Last sign-in: ${f.via.map(viaName).join(', ')}`, { via: [] });
  if (f.createdVia.length) add('createdVia', `Signed up via: ${f.createdVia.map(createdViaName).join(', ')}`, { createdVia: [] });
  if (f.onboarding) add('onboarding', `Onboarding: ${f.onboarding}`, { onboarding: undefined });
  if (f.verified !== undefined) add('verified', `Email ${f.verified ? 'verified' : 'not verified'}`, { verified: undefined });
  if (f.mfa !== undefined) add('mfa', `MFA ${f.mfa ? 'on' : 'off'}`, { mfa: undefined });
  if (f.plan) add('plan', `Plan: ${f.plan}`, { plan: undefined });
  if (f.paying) add('paying', 'Paying users', { paying: undefined });
  if (f.org) add('org', `Organization: ${f.org}`, { org: undefined });
  return chips;
}

const PLATFORM_NAME: Record<string, string> = {
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  server: 'Server',
  mcp: 'MCP',
  other: 'Other',
};
export function platformName(p: string): string {
  const name = PLATFORM_NAME[p];
  return name === undefined ? p : name;
}

const VIA_NAME: Record<string, string> = {
  password: 'Password',
  magic_link: 'Magic link',
  oauth: 'OAuth',
  passkey: 'Passkey',
  mfa: 'Password + MFA',
};
export function viaName(v: string): string {
  const name = VIA_NAME[v];
  return name === undefined ? v : name;
}

/** `oauth:google` as "Google (OAuth)", `magic_link` as "Magic link", null as "Unknown". */
export function createdViaName(v: string): string {
  if (v.startsWith('oauth:')) {
    const p = v.slice(6);
    return `${p.charAt(0).toUpperCase()}${p.slice(1)} (OAuth)`;
  }
  const names: Record<string, string> = {
    oauth: 'OAuth (any provider)',
    passkey: 'Passkey',
    password: 'Password sign-up',
    magic_link: 'Magic link',
    operator: 'Created by an operator',
    import: 'Imported',
    billing: 'Billing event',
    unknown: 'Unknown',
  };
  const name = names[v];
  return name === undefined ? v : name;
}
