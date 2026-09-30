/**
 * The Overview pages must not turn "you may not read this" into a fact about
 * the account. A member without developer:read used to see "API keys: 0
 * active" with an amber dot; without billing:read, "Plans: 0 active". And a
 * 429 on the stats read silently removed every tile instead of reaching the
 * busy notice.
 *
 * Rendered, with the API client mocked, because every failure here is in the
 * output or in which requests were sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const calls: string[] = [];
let scopes: string[] | null = null;
let billingEnabled = true;
let failWith: ((path: string) => Error | null) | null = null;
const overrides: Record<string, unknown> = {};

vi.mock('@/components/Link', () => ({
  default: ({ href, children, className }: { href: string; children: unknown; className?: string }) =>
    createElement('a', { href, className }, children as never),
}));

vi.mock('@/lib/api', async () => {
  const busy = await import('@/lib/api-busy');
  class PanelApiError extends Error {
    constructor(
      public statusCode: number,
      public code: string,
    ) {
      super(code);
    }
  }
  const isApiBusy = (e: unknown): boolean => e instanceof PanelApiError && busy.isApiBusyStatus(e.statusCode);
  const replies: Record<string, unknown> = {
    '/stats': {
      users: { total: 12, verified: 9, newLast7d: 3, newLast30d: 7, signupTrend: [{ date: '2026-09-29', count: 2 }] },
      security: { eventsLast30d: 12, signInsLast30d: 0, signUpsLast30d: 5 },
      billing: { enabled: true, activeSubscriptions: 4, plansActive: 2, plansTotal: 2 },
      usage: { creditsOutstanding: 10, usageLast30d: 5 },
      activeUsers: { d1: 1, d7: 2, d30: 5 },
      activitySeries: [{ date: '2026-09-29', count: 1 }],
    },
    '/api-keys': [],
    '/webhooks': { items: [], page: { total: 0, limit: 25, offset: 0 } },
    '/email-config': { transport: 'none' },
    '/billing-credentials': [],
    '/plans': { items: [], page: { total: 0, limit: 25, offset: 0 } },
  };
  return {
    PanelApiError,
    isApiBusy,
    unlessBusy:
      <T,>(fallback: () => T) =>
      (err: unknown): T => {
        if (isApiBusy(err)) throw err;
        return fallback();
      },
    getApplication: async () => ({
      id: 'app_1',
      name: 'Northwind',
      environment: 'DEVELOPMENT',
      authConfig: { methods: ['password'], organizationsEnabled: false },
      billingConfig: { enabled: billingEnabled, currency: 'USD' },
      oauthConfig: {},
      access: scopes === null ? undefined : { level: 'read', scopes },
    }),
    api: async ({ path }: { path: string }) => {
      const suffix = path.replace(/^\/api\/v1\/tenant\/applications\/app_1/, '');
      calls.push(suffix);
      const err = failWith?.(suffix);
      if (err) throw err;
      return suffix in overrides ? overrides[suffix] : replies[suffix];
    },
  };
});

async function renderOverview(): Promise<string> {
  const { default: Page } = await import('@/app/(authed)/applications/[id]/page');
  const tree = await Page({ params: Promise.resolve({ id: 'app_1' }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(tree);
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  calls.length = 0;
  scopes = null;
  billingEnabled = true;
  failWith = null;
  for (const k of Object.keys(overrides)) delete overrides[k];
});

describe('Application Overview', () => {
  it('an unrestricted caller reads everything and sees real counts', async () => {
    const html = await renderOverview();
    expect(calls.sort()).toEqual(['/api-keys', '/billing-credentials', '/email-config', '/plans', '/stats', '/webhooks']);
    expect(text(html)).toContain('0 active');
    expect(text(html)).not.toContain('not visible to your role');
  });

  it('never asks for, or claims, what the caller cannot read', async () => {
    scopes = ['overview:read', 'end-users:read'];
    const html = await renderOverview();
    expect(calls).toEqual(['/stats']);
    expect(text(html)).not.toMatch(/API keys\s+\S*\s*0 active/);
    expect(text(html)).not.toContain('0 active');
    expect(text(html).match(/not visible to your role/g)?.length).toBe(8);
    expect(html).not.toContain('/api-keys"');
    expect(html).not.toContain('/plans"');
    // Tiles into tabs the caller cannot open are plain text.
    expect(html).not.toContain('/revenue"');
    expect(html).toContain('/applications/app_1/end-users"');
  });

  it('says the numbers are hidden, not zero, without overview:read', async () => {
    scopes = ['developer:read'];
    const html = await renderOverview();
    expect(calls).not.toContain('/stats');
    expect(text(html)).toContain('Numbers are not visible to your role');
  });

  it('lets a busy stats read reach the busy notice', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as {
      PanelApiError: new (s: number, c: string) => Error;
    };
    failWith = (p) => (p === '/stats' ? new PanelApiError(429, 'RATE_LIMITED') : null);
    await expect(renderOverview()).rejects.toThrow('RATE_LIMITED');
  });

  it('shows a failed read as unreadable, not as zero', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as {
      PanelApiError: new (s: number, c: string) => Error;
    };
    failWith = (p) => (p === '/api-keys' ? new PanelApiError(500, 'INTERNAL_ERROR') : null);
    const html = await renderOverview();
    expect(text(html)).toMatch(/API keys\s+could not be read/);
  });

  it('hides Quick start once there is an active key and a user', async () => {
    const before = await renderOverview();
    expect(text(before)).toContain('Quick start');
    overrides['/api-keys'] = [{ id: 'k', revokedAt: null }];
    const after = await renderOverview();
    expect(text(after)).not.toContain('Quick start');
  });
});
