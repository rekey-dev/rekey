/**
 * End-users keeps list filters another page linked in with (Users >
 * Overview's "At risk"). Two ways that used to cost the operator the whole
 * list: a filter the caller has no scope for (the API answers 403, which the
 * panel turned into its forbidden page), and a value the API rejects (a 400
 * error page). Both are now a banner above an otherwise working page.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const calls: Array<{ path: string; interrupt: boolean | undefined }> = [];
let scopes: string[] | null = null;
let listReply: () => unknown = () => ({ items: [], page: { total: 0, limit: 25, offset: 0 } });

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/applications/app_1/end-users',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }),
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
      super(`${code} message`);
    }
  }
  return {
    PanelApiError,
    unlessBusy:
      <T,>(fallback: () => T) =>
      (err: unknown): T => {
        if (err instanceof PanelApiError && busy.isApiBusyStatus(err.statusCode)) throw err;
        return fallback();
      },
    errorQuery: async () => '',
    readErrorFlash: async () => ({}),
    getApplication: async () => ({ id: 'app_1', access: scopes === null ? undefined : { level: 'APP_VIEWER', scopes } }),
    api: async ({ path, interruptOnAccessError }: { path: string; interruptOnAccessError?: boolean }) => {
      calls.push({ path, interrupt: interruptOnAccessError });
      if (path.includes('/end-users?')) {
        const r = listReply();
        if (r instanceof Error) throw r;
        return r;
      }
      if (path.endsWith('/application-roles')) return [];
      if (path.endsWith('/organizations')) return { items: [], page: { total: 0, limit: 25, offset: 0 } };
      return { fields: [] };
    },
  };
});

async function render(sp: Record<string, string>): Promise<string> {
  const { default: Page } = await import('@/app/(authed)/applications/[id]/end-users/page');
  const tree = await Page({ params: Promise.resolve({ id: 'app_1' }), searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(tree);
}
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const listCall = () => calls.find((c) => c.path.includes('/end-users?'));

beforeEach(() => {
  calls.length = 0;
  scopes = null;
  listReply = () => ({ items: [], page: { total: 0, limit: 25, offset: 0 } });
});

describe('End-users linked filters', () => {
  it('passes the At risk filters through to the API', async () => {
    await render({ activeFrom: '2026-08-01', inactiveForDays: '14', minSignIns: '2', sort: 'lastActiveOn', order: 'desc' });
    expect(listCall()?.path).toContain('activeFrom=2026-08-01');
    expect(listCall()?.path).toContain('inactiveForDays=14');
    expect(listCall()?.path).toContain('sort=lastActiveOn');
  });

  it('drops a plan or org filter the caller cannot use, and says so', async () => {
    scopes = ['end-users:read'];
    const t = text(await render({ plan: 'pln_1', org: 'org_1' }));
    expect(listCall()?.path).not.toContain('plan=');
    expect(listCall()?.path).not.toContain('org=');
    expect(t).toContain('Ignored filters: plan (needs billing read access), org (needs organizations read access).');
  });

  it('keeps plan for a caller with billing read access', async () => {
    scopes = ['end-users:read', 'billing:read'];
    await render({ plan: 'pln_1' });
    expect(listCall()?.path).toContain('plan=pln_1');
  });

  it('shows an API refusal of a linked filter as a banner with a Clear link, not an error page', async () => {
    const { PanelApiError } = (await import('@/lib/api')) as unknown as {
      PanelApiError: new (s: number, c: string, f?: string) => Error;
    };
    listReply = () => new PanelApiError(400, 'VALIDATION_ERROR', 'Use YYYY-MM-DD.');
    const html = await render({ activeFrom: '2026-13-45' });
    expect(listCall()?.interrupt).toBe(false);
    expect(text(html)).toContain('These filters could not be applied: VALIDATION_ERROR message Use YYYY-MM-DD. Clear filters');
    expect(html).toContain('href="/applications/app_1/end-users"');
  });

  it('still lets an unfiltered 403 reach the forbidden page', async () => {
    await render({});
    expect(listCall()?.interrupt).toBe(true);
  });
});
