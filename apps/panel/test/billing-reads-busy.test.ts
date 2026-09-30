/**
 * Billing reads that used to swallow a busy API (429/503) or turn a failed
 * read into "0 active plans". A busy answer must reach the busy notice; a
 * failed plan read must be distinguishable from an empty catalogue.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let reply: (path: string) => unknown = () => undefined;
let scopes: string[] = ['billing:read'];

vi.mock('@/components/Link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/applications/app_1/billing',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

vi.mock('@/app/(authed)/applications/[id]/billing/actions', () => ({ setBillingEnabled: async () => undefined }));

vi.mock('@/lib/api', async () => {
  const busy = await import('@/lib/api-busy');
  class PanelApiError extends Error {
    constructor(public statusCode: number) {
      super(`HTTP ${statusCode}`);
    }
  }
  const isApiBusy = (e: unknown): boolean => e instanceof PanelApiError && busy.isApiBusyStatus(e.statusCode);
  const call = async (path: string): Promise<unknown> => {
    const r = reply(path);
    if (r instanceof Error) throw r;
    return r;
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
    apiGet: (path: string) => call(path),
    readErrorFlash: async () => ({}),
    api: ({ path }: { path: string }) => call(path),
    getApplication: async () => ({
      id: 'app_1',
      billingConfig: { enabled: true, currency: 'USD' },
      access: { level: 'read', scopes },
      name: 'Northwind',
    }),
  };
});

async function errorFor(status: number): Promise<Error> {
  const { PanelApiError } = (await import('@/lib/api')) as unknown as { PanelApiError: new (s: number) => Error };
  return new PanelApiError(status);
}

beforeEach(() => {
  reply = () => undefined;
  scopes = ['billing:read'];
});

describe('billing shared reads', () => {
  it('getPlans answers null for a failed read, not an empty page', async () => {
    const err = await errorFor(500);
    reply = () => err;
    const { getPlans } = await import('@/app/(authed)/applications/[id]/billing/shared');
    expect(await getPlans('app_1')).toBeNull();
  });

  it('getPlans rethrows a busy API', async () => {
    const err = await errorFor(429);
    reply = () => err;
    const { getPlans } = await import('@/app/(authed)/applications/[id]/billing/shared');
    await expect(getPlans('app_1')).rejects.toBe(err);
  });

  it('getReturnUrlEvents still hides a refusal but rethrows a busy API', async () => {
    const { getReturnUrlEvents } = await import('@/app/(authed)/applications/[id]/billing/shared');
    const refused = await errorFor(403);
    reply = () => refused;
    expect((await getReturnUrlEvents('app_1')).items).toEqual([]);
    const busy = await errorFor(503);
    reply = () => busy;
    await expect(getReturnUrlEvents('app_1')).rejects.toBe(busy);
  });
});

describe('Billing overview', () => {
  it('rethrows a busy stats read instead of dropping the tiles', async () => {
    const busy = await errorFor(429);
    reply = (p) => (p.endsWith('/billing/stats') ? busy : { items: [], page: { total: 0, limit: 8, offset: 0 } });
    const { default: Page } = await import('@/app/(authed)/applications/[id]/revenue/page');
    await expect(Page({ params: Promise.resolve({ id: 'app_1' }) })).rejects.toBe(busy);
  });

  it('says the numbers could not be read when stats fails', async () => {
    const broken = await errorFor(500);
    reply = (p) => (p.endsWith('/billing/stats') ? broken : { items: [], page: { total: 0, limit: 8, offset: 0 } });
    const { default: Page } = await import('@/app/(authed)/applications/[id]/revenue/page');
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: 'app_1' }) }));
    expect(html).toContain('Revenue numbers could not be read');
  });
});

describe('Billing setup', () => {
  const empty = (p: string): unknown =>
    p.endsWith('/billing/providers') ? { providers: [] } : p.endsWith('/checkout/status') ? null : { items: [], page: { total: 0, limit: 25, offset: 0 } };

  async function render(): Promise<string> {
    reply = empty;
    const { default: Page } = await import('@/app/(authed)/applications/[id]/billing/page');
    const tree = await Page({ params: Promise.resolve({ id: 'app_1' }), searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(tree);
  }

  it('offers the on/off switch only to a caller who may change it', async () => {
    scopes = ['billing:read'];
    const readOnly = await render();
    expect(readOnly).not.toContain('Disable billing');
    expect(readOnly).toContain('needs billing write access');
    scopes = ['billing:read', 'billing:write'];
    expect(await render()).toContain('Disable billing');
  });

  it('says the plans could not be read rather than none are active', async () => {
    const broken = await errorFor(500);
    const { default: Page } = await import('@/app/(authed)/applications/[id]/billing/page');
    reply = (p) => (p.endsWith('/plans') ? broken : empty(p));
    const html = renderToStaticMarkup(
      await Page({ params: Promise.resolve({ id: 'app_1' }), searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('Could not be read');
    expect(html).not.toContain('No active plans');
  });
});
