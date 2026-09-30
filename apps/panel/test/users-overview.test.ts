/**
 * Users > Overview: URL filter parsing, the request budget, and every state a
 * section can arrive in. Rendered against a mocked API, because the bugs this
 * guards against are in what the page sends and what it prints.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activeFilterCount, effectiveFilters, filterParams, isUnnarrowed, parseUsersQuery, usersHref } from '@/lib/users-filters';
import type { AnalyticsActivity, AnalyticsKpis } from '@rekey.dev/shared-types';
import { describeDelta, needsLivePath } from '@/lib/users-analytics';

// ── filters ────────────────────────────────────────────────────────────────

describe('parseUsersQuery', () => {
  it('defaults to the last 30 days compared with the previous period', () => {
    const { filters, view, ignored } = parseUsersQuery({}, null);
    expect(filters).toMatchObject({ range: '30d', compare: 'prev', platform: [], country: [], via: [] });
    expect(view.metric).toBe('dau');
    expect(ignored).toEqual([]);
  });

  it('drops unknown params and says so', () => {
    const { ignored, filters } = parseUsersQuery({ email: 'ada@example.org', range: '7d' }, null);
    expect(filters.range).toBe('7d');
    expect(ignored).toEqual([{ param: 'email', reason: 'not a filter on this page' }]);
  });

  it('keeps valid values and reports each bad one', () => {
    const { filters, ignored } = parseUsersQuery(
      { platform: 'ios,web,fridge', country: 'de,USA', via: ['passkey', 'carrier-pigeon'], verified: 'yes', mfa: 'true' },
      null,
    );
    expect(filters.platform).toEqual(['ios', 'web']);
    expect(filters.country).toEqual(['DE']);
    expect(filters.via).toEqual(['passkey']);
    expect(filters.mfa).toBe(true);
    expect(filters.verified).toBeUndefined();
    expect(ignored.map((i) => i.param)).toEqual(['platform', 'country', 'via', 'verified']);
  });

  it('keeps a custom range custom, and asks the API for 30 days until both dates are valid', () => {
    const full = parseUsersQuery({ range: 'custom', from: '2026-09-01', to: '2026-09-10' }, null).filters;
    expect(full).toMatchObject({ range: 'custom', from: '2026-09-01', to: '2026-09-10' });
    expect(effectiveFilters(full)).toBe(full);

    const bare = parseUsersQuery({ range: 'custom' }, null);
    expect(bare.filters.range).toBe('custom');
    expect(bare.ignored).toEqual([]);
    expect(effectiveFilters(bare.filters).range).toBe('30d');

    const backwards = parseUsersQuery({ range: 'custom', from: '2026-09-10', to: '2026-09-01' }, null);
    expect(backwards.filters.range).toBe('custom');
    expect(backwards.ignored[0]?.param).toBe('from');
    expect(filterParams(effectiveFilters(backwards.filters))).toContainEqual(['range', '30d']);
  });

  it('drops a profile question for a caller without end-users read access', () => {
    const r = parseUsersQuery({ field: 'team_size' }, ['overview:read']);
    expect(r.view.field).toBeUndefined();
    expect(r.ignored).toEqual([{ param: 'field', reason: 'needs end-users read access' }]);
    expect(parseUsersQuery({ field: 'team_size' }, ['overview:read', 'end-users:read']).view.field).toBe('team_size');
  });

  it('calls a view narrowed only when a filter is on or the range ended before today', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const f = (sp: Record<string, string>) => parseUsersQuery(sp, null).filters;
    expect(isUnnarrowed(f({}), now)).toBe(true);
    expect(isUnnarrowed(f({ range: '7d' }), now)).toBe(true);
    expect(isUnnarrowed(f({ platform: 'ios' }), now)).toBe(false);
    expect(isUnnarrowed(f({ range: 'custom', from: '2026-08-01', to: '2026-08-31' }), now)).toBe(false);
    expect(isUnnarrowed(f({ range: 'custom', from: '2026-09-01', to: '2026-09-29' }), now)).toBe(true);
  });

  it('drops plan and org filters the caller has no scope for', () => {
    const restricted = parseUsersQuery({ plan: 'pln_1', org: 'org_1', paying: 'true' }, ['overview:read']);
    expect(restricted.filters.plan).toBeUndefined();
    expect(restricted.filters.org).toBeUndefined();
    expect(restricted.filters.paying).toBeUndefined();
    expect(restricted.ignored.map((i) => i.reason)).toEqual([
      'needs billing read access',
      'needs billing read access',
      'needs organizations read access',
    ]);
    const allowed = parseUsersQuery({ plan: 'pln_1', org: 'org_1' }, ['overview:read', 'billing:read', 'organizations:read']);
    expect(allowed.filters).toMatchObject({ plan: 'pln_1', org: 'org_1' });
  });

  it('treats an empty form field as unset', () => {
    const { filters, ignored } = parseUsersQuery({ onboarding: '', country: '', verified: '' }, null);
    expect(filters.onboarding).toBeUndefined();
    expect(filters.country).toEqual([]);
    expect(ignored).toEqual([]);
  });

  it('writes a stable, sorted query and a short page URL', () => {
    const { filters } = parseUsersQuery({ platform: 'web,ios', country: 'US,DE', verified: 'true' }, null);
    expect(filterParams(filters)).toEqual([
      ['compare', 'prev'],
      ['country', 'DE,US'],
      ['platform', 'ios,web'],
      ['range', '30d'],
      ['verified', 'true'],
    ]);
    expect(usersHref('app_1', filters, { metric: 'wau' })).toBe(
      '/applications/app_1/users?country=DE%2CUS&platform=ios%2Cweb&verified=true&metric=wau',
    );
    expect(activeFilterCount(filters)).toBe(3);
  });
});

describe('sign-up source filter and the live-data cap', () => {
  it('accepts kinds, oauth:<provider> and unknown, and drops the rest', () => {
    const { filters, ignored } = parseUsersQuery({ createdVia: 'oauth,oauth:github,unknown,carrier' }, null);
    expect(filters.createdVia).toEqual(['oauth', 'oauth:github', 'unknown']);
    expect(ignored).toEqual([{ param: 'createdVia', reason: 'unknown sign-up source "carrier"' }]);
  });

  it('knows which filters only live data can answer', () => {
    const f = (sp: Record<string, string>) => parseUsersQuery(sp, null).filters;
    expect(needsLivePath(f({ platform: 'ios' }))).toBe(false);
    expect(needsLivePath(f({ platform: 'ios', country: 'DE' }))).toBe(true);
    expect(needsLivePath(f({ verified: 'true' }))).toBe(true);
    expect(needsLivePath(f({ createdVia: 'oauth' }))).toBe(false);
  });
});

describe('describeDelta', () => {
  it('shows counts in percent and rates in points, coloured by polarity', () => {
    expect(describeDelta({ value: 110, previous: 100 }, 'count')).toEqual({ text: '10.0%', direction: 'up', good: true });
    expect(describeDelta({ value: 90, previous: 100 }, 'count', 'down_is_good')).toEqual({ text: '10.0%', direction: 'down', good: true });
    expect(describeDelta({ value: 0.25, previous: 0.22 }, 'rate')).toEqual({ text: '3.0 pt', direction: 'up', good: true });
    expect(describeDelta({ value: 5, previous: null }, 'count')).toBeNull();
    expect(describeDelta({ value: null, previous: 5 }, 'count')).toBeNull();
    expect(describeDelta({ value: 5, previous: 0 }, 'count')).toMatchObject({ text: 'new', direction: 'up' });
  });
});

// ── the page ───────────────────────────────────────────────────────────────

const calls: string[] = [];
let scopes: string[] | null = null;
let reply: (path: string) => unknown = () => ({});
let pathname = '/applications/app_1/users';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => pathname,
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));
vi.mock('@/components/Link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
}));
vi.mock('@/lib/api', async () => {
  const busy = await import('@/lib/api-busy');
  class PanelApiError extends Error {
    constructor(
      public statusCode: number,
      public code: string,
      public fix?: string,
    ) {
      super(code);
    }
  }
  const call = async (path: string): Promise<unknown> => {
    calls.push(path);
    const r = reply(path);
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    PanelApiError,
    isApiBusy: (e: unknown) => e instanceof PanelApiError && busy.isApiBusyStatus(e.statusCode),
    api: ({ path }: { path: string }) => call(path),
    getApplication: (id: string) =>
      call(`/api/v1/tenant/applications/${id}`).then(() => ({
        id,
        name: 'Northwind',
        billingConfig: { enabled: true },
        reportingTimezone: 'Europe/Berlin',
        access: scopes === null ? undefined : { level: 'read', scopes },
      })),
  };
});

const today = '2026-09-29';
const dates = ['2026-09-27', '2026-09-28', today];
const metric = (value: number, previous: number | null = value) => ({ value, previous, delta: previous === null ? null : value - previous });
const ok = <T,>(data: T) => ({
  status: 'ok',
  source: 'live',
  timezone: 'Europe/Berlin',
  computedAt: `${today}T10:00:00Z`,
  cache: { hit: false, ageSeconds: 0, stale: false },
  data,
  ignoredFilters: [],
  gaps: [],
});
const KPIS: AnalyticsKpis = {
  totalUsers: { ...metric(48210, 46000), erased: 3 },
  newUsers: metric(2104, 2300),
  dau: metric(5932, 5800),
  dauAverage: metric(5710, 5600),
  wau: metric(14880),
  mau: metric(27301),
  stickiness: metric(0.217, 0.2),
  payingUsers: metric(1944),
  conversion: metric(0.04),
};
const ACTIVITY: AnalyticsActivity = {
  segments: [
    {
      timezone: 'Europe/Berlin',
      from: dates[0]!,
      to: today,
      points: dates.map((d, i) => ({
        date: d,
        dau: 10 + i,
        wau: 30,
        mau: 90,
        accountsCreated: 3,
        previous: { date: d, dau: 8, wau: 30, mau: 90, accountsCreated: 2 },
      })),
    },
  ],
  accountsBefore: 100,
  signIns: {
    status: 'ok',
    timezone: 'Europe/Berlin',
    from: dates[0]!,
    to: today,
    points: dates.map((d) => ({ date: d, total: 7, byVia: { password: 5, passkey: 2 } })),
    partial: false,
    ignoredFilters: [],
  },
};
function envelope(sections: Record<string, unknown>) {
  return {
    asOf: `${today}T10:00:00Z`,
    range: { from: dates[0], to: today, days: 3, timezone: 'Europe/Berlin', compare: null },
    coverage: {
      activityFrom: '2026-07-29',
      wauFrom: '2026-08-04',
      mauFrom: '2026-08-27',
      trackedSince: '2026-07-01',
      signInsFrom: dates[0],
      rollupFrom: null,
      timezone: 'Europe/Berlin',
      timezoneNote: null,
    },
    filters: {},
    sections,
  };
}

/** Resolve every async server component in a tree, so the page renders to a string like Next would. */
async function resolve(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!node || typeof node !== 'object' || !('type' in node)) return node;
  const el = node as ReactElement<{ children?: unknown; fallback?: unknown }>;
  if (typeof el.type === 'function' && el.type.constructor.name === 'AsyncFunction') {
    return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && 'children' in el.props) {
    return { ...el, props: { ...el.props, children: await resolve(el.props.children) } };
  }
  return el;
}

async function renderPage(sp: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/(authed)/applications/[id]/users/page');
  const tree = await Page({ params: Promise.resolve({ id: 'app_1' }), searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup((await resolve(tree)) as ReactElement);
}
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const bd = (pairs: Array<[string, number]>, unknown = 0) => {
  const total = pairs.reduce((a, [, c]) => a + c, 0) + unknown;
  return { rows: pairs.map(([key, count]) => ({ key, count, share: count / total })), other: 0, unknown, total };
};
const REST = {
  mix: ok({
    platform: bd([['ios', 30], ['web', 70]]),
    country: bd([]),
    lastSignInVia: bd([['passkey', 5]]),
    createdVia: bd([['oauth:google', 3], ['operator', 1]]),
    oauthProviders: bd([['google', 4]]),
    liveSessions: null,
  }),
  onboarding: ok({
    funnel: {
      steps: [
        { key: 'created', count: 200 },
        { key: 'verified', count: 150 },
        { key: 'first_sign_in', count: 140 },
        { key: 'onboarding_completed', count: 100 },
        { key: 'active_7d', count: 90 },
      ],
      skipped: 20,
    },
    counts: { completed: 900, skipped: 100, pending: 300, total: 1300 },
    cohortCounts: { completed: 100, skipped: 20, pending: 80, total: 200 },
    medianSecondsToComplete: 4320,
    fields: [{ key: 'team_size', label: 'Team size', type: 'select' }],
    answers: { key: 'team_size', label: 'Team size', breakdown: bd([['2-10', 12]]) },
  }),
  retention: ok({ cohorts: [{ weekStart: '2026-09-14', size: 40, retained: [40, 16] }] }),
  security: ok({
    total: 100,
    verified: { count: 80, share: 0.8 },
    mfa: { count: 12, share: 0.12 },
    passkeys: { count: 7, share: 0.07 },
    devices: { active: 50, blocked: 2, released: 4 },
    lockouts: { status: 'unavailable', reason: 'not_captured', fix: 'x' },
    trend: [],
  }),
  billing: ok({ plans: [{ planId: 'pro', planName: 'Pro', status: 'ACTIVE', count: 9 }], trialConversion: { ended: 10, converted: 4, rate: 0.4 } }),
  usage: ok({ from: '2026-09-23', to: today, partial: true, meters: [{ meterId: 'm', slug: 'api', name: 'API calls', unit: 'call', units: 1000 }] }),
};
const both = (p: string): unknown =>
  p.includes('sections=kpis') ? envelope({ kpis: ok(KPIS), activity: ok(ACTIVITY) }) : envelope(REST);

beforeEach(() => {
  calls.length = 0;
  scopes = null;
  pathname = '/applications/app_1/users';
  reply = (p) => (p.includes('/analytics/users') ? both(p) : {});
});

describe('Users overview page', () => {
  it('costs at most three API calls: the application and one analytics call per half', async () => {
    await renderPage({ platform: 'ios' });
    expect(calls.length).toBeLessThanOrEqual(3);
    const analytics = calls.filter((c) => c.includes('/analytics/users'));
    expect(analytics).toEqual([
      '/api/v1/tenant/applications/app_1/analytics/users?compare=prev&platform=ios&range=30d&sections=kpis%2Cactivity',
      '/api/v1/tenant/applications/app_1/analytics/users?compare=prev&platform=ios&range=30d&sections=mix%2Conboarding%2Cretention%2Csecurity%2Cbilling%2Cusage',
    ]);
  });

  it('renders the breakdowns, funnel, retention and health', async () => {
    const t = text(await renderPage());
    expect(t).toContain('Web 70 70.0%');
    expect(t).toContain('Google (OAuth) 3 75.0%');
    expect(t).toContain('No countries recorded. This deployment does not trust the CF-IPCountry header');
    expect(t).toContain('Onboarding completed 100 71.4% of previous');
    expect(t).toContain('Skipped instead: 20');
    expect(t).toContain('1h 12m');
    expect(t).toContain('Sep 14 40 100% 40%');
    expect(t).toContain('Pro · active 9 100.0%');
    expect(t).toContain('API calls (call) 1,000');
    expect(t).toContain('MFA on 12.0%');
    expect(t).toContain('Trial conversion: 40.0%');
  });

  it('links "At risk" to the End-users list filters the API serves', async () => {
    const html = await renderPage();
    expect(html).toMatch(/end-users\?activeFrom=\d{4}-\d{2}-\d{2}&amp;inactiveForDays=14&amp;minSignIns=2&amp;sort=lastActiveOn&amp;order=desc/);
  });

  it('does not ask for billing sections without billing:read, and says why', async () => {
    scopes = ['overview:read', 'end-users:read'];
    const t = text(await renderPage());
    const rest = calls.find((c) => c.includes('sections=mix'));
    expect(rest).toMatch(/sections=mix%2Conboarding%2Cretention%2Csecurity$/);
    expect(t.match(/Not visible to your role/g)?.length).toBe(2);
    expect(t).toContain('does not include billing:read');
  });

  it('offers profile questions only to callers who may read the answers', async () => {
    scopes = ['overview:read'];
    const t = text(await renderPage());
    expect(t).not.toContain('Answers, accounts created in range');
    scopes = ['overview:read', 'end-users:read'];
    expect(text(await renderPage())).toContain('Answers, accounts created in range');
  });

  it('says why the lower half is missing when the API refuses its request', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as {
      PanelApiError: new (s: number, c: string, f?: string) => Error;
    };
    reply = (p) =>
      p.includes('sections=mix') ? new PanelApiError(403, 'SCOPE_INSUFFICIENT', 'Ask for end-users:read.') : both(p);
    const t = text(await renderPage());
    expect(t).toContain('The lower sections could not be loaded: SCOPE_INSUFFICIENT Ask for end-users:read.');
    expect(t).toContain('Active users');
  });

  it('keeps the lower sections under a filter that matches nobody', async () => {
    const zero = { ...REST, onboarding: ok({ ...(REST.onboarding.data as object), counts: { completed: 0, skipped: 0, pending: 0, total: 0 } }) };
    reply = (p) =>
      p.includes('/analytics/users')
        ? p.includes('sections=kpis')
          ? envelope({ kpis: ok({ ...KPIS, totalUsers: { ...metric(0), erased: 0 } }), activity: ok(ACTIVITY) })
          : envelope(zero)
        : {};
    expect(text(await renderPage({ platform: 'ios' }))).toContain('Who they are');
    expect(text(await renderPage())).not.toContain('Who they are');
  });

  it('passes the chosen profile question through', async () => {
    await renderPage({ field: 'team_size' });
    expect(calls.find((c) => c.includes('sections=mix'))).toContain('profileField=team_size');
  });

  it('shows a failed breakdown once, not once per card', async () => {
    reply = (p) =>
      p.includes('sections=mix')
        ? envelope({ ...REST, mix: { status: 'error', error: { code: 'ANALYTICS_TIMEOUT', message: 'Too slow.', fix: 'Narrow it.' } } })
        : both(p);
    const t = text(await renderPage());
    expect(t.match(/Too slow\./g)?.length).toBe(1);
  });

  it('renders the KPI row with deltas and names the timezone', async () => {
    const t = text(await renderPage());
    expect(t).toContain('Total users 48.2K');
    expect(t).toContain('includes 3 erased');
    expect(t).toContain('5,710 a day on average');
    expect(t).toContain('4.0% of all users, now');
    expect(t).toContain('Europe/Berlin days');
    expect(t).toContain('Stickiness 21.7%');
    expect(t).toContain('Europe/Berlin days');
  });

  it('never calls the API for a caller without overview:read', async () => {
    scopes = ['end-users:read'];
    const t = text(await renderPage());
    expect(calls.filter((c) => c.includes('/analytics/'))).toEqual([]);
    expect(t).toContain('Users overview is not visible to your role');
  });

  it.each([
    [{ status: 'error', error: { code: 'ANALYTICS_TIMEOUT', message: 'Took too long.', fix: 'Narrow the range.' } }, ['Took too long.', 'Narrow the range.', 'Retry']],
    [{ status: 'forbidden', scope: 'billing:read' }, ['Not visible to your role', 'billing:read']],
    [{ status: 'pending', retryAfterSeconds: 5 }, ['Still calculating', 'Refresh']],
    [{ status: 'unavailable', reason: 'needs_rollup', fix: 'Collecting daily history.' }, ['Needs daily history', 'Collecting daily history.']],
    [{ status: 'banana' }, ['Could not be shown']],
    [{ status: 'ok', source: 'live' }, ['Could not be shown']],
  ])('shows the activity section in state %j', async (activity, expected) => {
    reply = (p) => (p.includes('/analytics/users') ? envelope({ kpis: ok(KPIS), activity }) : {});
    const t = text(await renderPage());
    for (const e of expected) expect(t).toContain(e);
    // One failing section never blanks the others.
    expect(t).toContain('Total users 48.2K');
  });

  it('says so when the API predates the route', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as { PanelApiError: new (s: number, c: string) => Error };
    reply = (p) => (p.includes('/analytics/users') ? new PanelApiError(404, 'ROUTE_NOT_FOUND') : {});
    const html = await renderPage();
    expect(text(html)).toContain('This API does not serve the Users overview yet');
    expect(html).toContain('href="/applications/app_1/end-users"');
  });

  it('shows the API refusal with its fix', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as {
      PanelApiError: new (s: number, c: string, f?: string) => Error;
    };
    reply = (p) =>
      p.includes('/analytics/users') ? new PanelApiError(400, 'ANALYTICS_RANGE_TOO_LONG', 'Shorten to 63 days.') : {};
    expect(text(await renderPage({ range: '12m' }))).toContain('Shorten to 63 days.');
  });

  it('lets a busy API reach the busy notice', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as { PanelApiError: new (s: number, c: string) => Error };
    reply = (p) => (p.includes('/analytics/users') ? new PanelApiError(503, 'ANALYTICS_BUSY') : {});
    await expect(renderPage()).rejects.toThrow('ANALYTICS_BUSY');
  });

  it('switches daily, weekly and monthly without another request, and keeps each a link', async () => {
    const html = await renderPage({ metric: 'wau' });
    expect(html).toContain('aria-label="Weekly active users, ');
    expect(html).not.toContain('aria-label="Daily active users, ');
    expect(html).toMatch(/<a href="\/applications\/app_1\/users"[^>]*>Daily<\/a>/);
    expect(html).toMatch(/<a href="\/applications\/app_1\/users\?metric=mau"[^>]*>Monthly<\/a>/);
    expect(calls.filter((c) => c.includes('/analytics/users')).every((c) => !c.includes('metric'))).toBe(true);
  });

  it('shows the date inputs, prefilled, when the range is custom without dates', async () => {
    const html = await renderPage({ range: 'custom' });
    for (const id of ['uo-from', 'uo-to']) {
      const input = new RegExp(`<input id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(input).toMatch(/value="\d{4}-\d{2}-\d{2}"/);
      expect(input).toContain('type="date"');
    }
    expect(html).toContain('>Apply</button>');
    expect(calls.find((c) => c.includes('sections=kpis'))).toContain('range=30d');
  });

  it('says a filter matches nobody instead of claiming the app has no users', async () => {
    reply = (p) =>
      p.includes('/analytics/users')
        ? envelope({ kpis: ok({ ...KPIS, totalUsers: { ...metric(0), erased: 0 } }), activity: ok(ACTIVITY) })
        : {};
    const html = await renderPage({ platform: 'ios' });
    const t = text(html);
    expect(t).not.toContain('No users yet');
    expect(t).toContain('No users match these filters. Clear filters');
    expect(html).toContain('href="/applications/app_1/users"');
    expect(t).toContain('Active users');
  });

  it('shows one empty state when the application has no users', async () => {
    reply = (p) =>
      p.includes('/analytics/users')
        ? envelope({ kpis: ok({ ...KPIS, totalUsers: metric(0) }), activity: ok(ACTIVITY) })
        : {};
    const t = text(await renderPage());
    expect(t).toContain('No users yet');
    expect(t).not.toContain('Active users');
  });

  it('offers a shorter range when live-only filters meet a long one', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as {
      PanelApiError: new (s: number, c: string, f?: string) => Error;
    };
    reply = (p) => (p.includes('/analytics/users') ? new PanelApiError(400, 'ANALYTICS_RANGE_TOO_LONG', 'Shorten to 63 days.') : {});
    const html = await renderPage({ range: '90d', verified: 'true' });
    expect(text(html)).toContain('Shorten to 63 days. Show the last 30 days with these filters');
    expect(html).toContain('href="/applications/app_1/users?verified=true"');
  });

  it('draws one chart per timezone segment and never joins them', async () => {
    const seg = ACTIVITY.segments[0]!;
    const split = { ...ACTIVITY, segments: [{ ...seg, timezone: 'UTC', to: dates[0]!, points: seg.points.slice(0, 1) }, { ...seg, from: dates[1]!, points: seg.points.slice(1) }] };
    reply = (p) => (p.includes('/analytics/users') ? envelope({ kpis: ok(KPIS), activity: ok(split) }) : {});
    const t = text(await renderPage());
    expect(t).toContain('days counted in UTC');
    expect(t).toContain('days counted in Europe/Berlin');
  });

  it('explains sign-ins by method when the history is not there', async () => {
    const noSignIns = { ...ACTIVITY, signIns: { status: 'unavailable', reason: 'needs_rollup', fix: 'Run the backfill.' } };
    reply = (p) => (p.includes('/analytics/users') ? envelope({ kpis: ok(KPIS), activity: ok(noSignIns) }) : {});
    expect(text(await renderPage())).toContain('Needs daily history, which this deployment is still collecting. Run the backfill.');
  });

  it('shows a dash, not a zero, for a number outside the window', async () => {
    reply = (p) =>
      p.includes('/analytics/users') ? envelope({ kpis: ok({ ...KPIS, mau: { value: null, previous: null, delta: null } }), activity: ok(ACTIVITY) }) : {};
    expect(text(await renderPage())).toContain('Monthly active — not available for this range, see the note below');
  });

  it('explains blank numbers with the gap note and a shorter-range link', async () => {
    const gap = {
      reason: 'filter_not_in_rollup',
      metrics: ['wau', 'mau'],
      days: ['2026-07-01', '2026-07-02', '2026-07-03'],
      fix: 'Remove the filter or pick 63 days or fewer.',
    };
    const nullWau = { ...KPIS, wau: { value: null, previous: null, delta: null }, mau: { value: null, previous: null, delta: null } };
    reply = (p) => (p.includes('/analytics/users') ? envelope({ kpis: { ...ok(nullWau), gaps: [gap] }, activity: ok(ACTIVITY) }) : {});
    const html = await renderPage({ range: '90d', platform: 'ios' });
    const t = text(html);
    expect(t).toContain(
      'No weekly active users and monthly active users on 3 days (2026-07-01 to 2026-07-03). The daily history does not keep these under the filters you chose. Remove the filter or pick 63 days or fewer. Show the last 30 days',
    );
    expect(html).toContain('href="/applications/app_1/users?platform=ios"');
    const short = text(await renderPage({ range: '30d', platform: 'ios' }));
    expect(short).toContain('Remove the filter or pick 63 days or fewer.');
    expect(short).not.toContain('Show the last 30 days');
  });

  it('reports ignored params in a banner', async () => {
    expect(text(await renderPage({ email: 'ada@example.org' }))).toContain('Ignored filter: email (not a filter on this page)');
  });
});

describe('AppNav', () => {
  async function nav(props: { usersOverview?: boolean; scopes?: string[] | null }): Promise<string> {
    pathname = '/applications/app_1/end-users';
    const { AppNav } = await import('@/components/AppNav');
    return renderToStaticMarkup(createElement(AppNav, { id: 'app_1', billingEnabled: true, ...props }));
  }

  it('puts Overview first under Users', async () => {
    const html = await nav({});
    expect(html.indexOf('href="/applications/app_1/users"')).toBeGreaterThan(-1);
    // The sub-tab row, after the group pills.
    expect(html.indexOf('href="/applications/app_1/users"')).toBeLessThan(html.lastIndexOf('href="/applications/app_1/end-users"'));
  });

  it('hides the tab when the API predates it, or the caller lacks overview:read', async () => {
    expect(await nav({ usersOverview: false })).not.toContain('href="/applications/app_1/users"');
    expect(await nav({ scopes: ['end-users:read'] })).not.toContain('href="/applications/app_1/users"');
  });
});
