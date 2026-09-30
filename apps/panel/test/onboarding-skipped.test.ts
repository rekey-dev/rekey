/**
 * Skipped onboarding in the panel: the End-users list says which of the three
 * states a user is in, and the Onboarding page counts them from one aggregate
 * read instead of paging every user.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let reply: (path: string) => unknown = () => ({});
const calls: string[] = [];

vi.mock('@/components/Link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
}));
vi.mock('@/lib/api', async () => {
  class PanelApiError extends Error {
    constructor(
      public statusCode: number,
      public code: string,
    ) {
      super(code);
    }
  }
  return {
    PanelApiError,
    isApiBusy: (e: unknown) => e instanceof PanelApiError && (e.statusCode === 429 || e.statusCode === 503),
    api: async ({ path }: { path: string }) => {
      calls.push(path);
      const r = reply(path);
      if (r instanceof Error) throw r;
      return r;
    },
  };
});

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const envelope = (onboarding: unknown) => ({
  asOf: '2026-09-29T10:00:00Z',
  range: { from: '2026-08-31', to: '2026-09-29', days: 30, timezone: 'UTC', compare: null },
  coverage: { activityFrom: '2026-07-29', signInsFrom: null, rollupFrom: null, trackedSince: '2026-07-01' },
  sections: { onboarding },
});
const okCounts = {
  status: 'ok',
  source: 'live',
  timezone: 'UTC',
  computedAt: '2026-09-29T10:00:00Z',
  cache: { hit: false, ageSeconds: 0, stale: false },
  ignoredFilters: [],
  data: {
    funnel: { steps: [], skipped: 0 },
    counts: { completed: 600, skipped: 150, pending: 250, total: 1000 },
    cohortCounts: { completed: 0, skipped: 0, pending: 0, total: 0 },
    medianSecondsToComplete: null,
    fields: [],
    answers: null,
  },
};

async function counts(): Promise<string> {
  const { OnboardingStatusCounts } = await import('@/app/(authed)/applications/[id]/onboarding/status-counts');
  const el = await OnboardingStatusCounts({ applicationId: 'app_1' });
  return el === null ? '' : renderToStaticMarkup(el);
}

beforeEach(() => {
  calls.length = 0;
  reply = () => envelope(okCounts);
});

describe('Onboarding status counts', () => {
  it('reads one aggregate and shows completed, skipped and pending with shares', async () => {
    const t = text(await counts());
    expect(calls).toEqual(['/api/v1/tenant/applications/app_1/analytics/users?compare=prev&range=30d&sections=onboarding']);
    expect(t).toContain('Completed 600 60.0%');
    expect(t).toContain('Skipped 150 15.0%');
    expect(t).toContain('Pending 250 25.0%');
  });

  it('renders nothing when the section is not ok or the API predates it', async () => {
    reply = () => envelope({ status: 'pending' });
    expect(await counts()).toBe('');
    const { PanelApiError } = (await import('@/lib/api')) as unknown as { PanelApiError: new (s: number, c: string) => Error };
    reply = () => new PanelApiError(404, 'ROUTE_NOT_FOUND');
    expect(await counts()).toBe('');
  });

  it('says the counts are busy instead of replacing the page, and rethrows anything else', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as { PanelApiError: new (s: number, c: string) => Error };
    reply = () => new PanelApiError(429, 'RATE_LIMITED');
    expect(text(await counts())).toContain('Onboarding counts are busy right now');
    reply = () => new PanelApiError(500, 'INTERNAL_ERROR');
    await expect(counts()).rejects.toThrow('INTERNAL_ERROR');
  });
});

describe('End-users onboarding column', () => {
  it('names each state and shows a dash on an older API', async () => {
    const { OnboardingBadge } = await import('@/app/(authed)/applications/[id]/end-users/onboarding-badge');
    const r = (status?: 'pending' | 'completed' | 'skipped'): string => text(renderToStaticMarkup(createElement(OnboardingBadge, { status })));
    expect(r('completed')).toBe('completed');
    expect(r('skipped')).toBe('skipped');
    expect(r('pending')).toBe('pending');
    expect(r(undefined)).toBe('—');
  });
});
