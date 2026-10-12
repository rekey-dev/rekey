/**
 * What an empty page of the billing log says. A view that lists nothing while
 * the log has entries says so and offers Everything; "Nothing logged yet" is
 * kept for a log that is empty. The read that tells the two apart is made
 * only for an empty page.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyLogState, emptyPageNeedsWholeLogRead } from '@/lib/billing-log';

let requests: string[] = [];
let reply: (path: string) => unknown = () => ({ items: [], nextCursor: null, actors: null });

vi.mock('@/components/Link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));
vi.mock('@/components/BillingLogTable', () => ({
  BillingLogTable: ({ entries }: { entries: unknown[] }) => createElement('table', { 'data-entries': entries.length }),
}));
vi.mock('@/lib/api', () => {
  class PanelApiError extends Error {}
  return {
    PanelApiError,
    unlessBusy:
      <T,>(fallback: () => T) =>
      (): T =>
        fallback(),
    apiGet: async (path: string) => {
      requests.push(path);
      const answered = reply(path);
      if (answered instanceof Error) throw answered;
      return answered;
    },
    getApplication: async () => ({ id: 'app_1', billingConfig: { enabled: true } }),
  };
});

const ENTRY = {
  seq: '7',
  type: 'plan.price_set',
  tier: 'PERMANENT',
  occurredAt: '2026-10-11T10:00:00.000Z',
  actor: { type: 'operator', id: 'op_1' },
  provider: null,
  providerEventId: null,
  endUserId: null,
  subscriptionId: null,
  checkoutSessionId: null,
  paymentId: null,
  planId: 'plan_1',
  planPriceId: 'pp_1',
  currency: 'INR',
  amount: 149900,
  data: { planSlug: 'pro', isDefault: false, before: null, after: { amount: 149900, countries: [] } },
};
const isWholeLogRead = (path: string): boolean => path.endsWith('/billing/events?limit=1');

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import('@/app/(authed)/applications/[id]/billing-log/page');
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: 'app_1' }), searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  requests = [];
  reply = () => ({ items: [], nextCursor: null, actors: null });
});

describe('emptyLogState', () => {
  it('says the view lists nothing when the log has entries, and offers Everything', () => {
    const state = emptyLogState({ view: 'activity' }, true);
    expect(state.title).toBe('Nothing in this view');
    expect(state.description).toBe('The log has entries in other views. "Money and refusals" lists none of them.');
    expect(state.offerEverything).toBe(true);
  });

  it('says nothing is logged yet only when the log is empty', () => {
    for (const view of ['activity', 'configuration', 'diagnostics'] as const) {
      expect(emptyLogState({ view }, false), view).toMatchObject({ title: 'Nothing logged yet', offerEverything: false });
      expect(emptyLogState({ view }, true).title, view).not.toBe('Nothing logged yet');
    }
    expect(emptyLogState({ view: 'all' }, null)).toMatchObject({ title: 'Nothing logged yet', offerEverything: false });
    expect(emptyLogState({ view: 'activity', currency: 'INR' }, false).title).toBe('Nothing logged yet');
  });

  it('claims nothing about the rest of the log when the read of it failed', () => {
    const state = emptyLogState({ view: 'activity' }, null);
    expect(state.title).toBe('Nothing in this view');
    expect(state.description).toContain('may have entries');
    expect(state.offerEverything).toBe(true);
  });

  it('says the filters leave entries out when it is a filter, not the view, that does', () => {
    const state = emptyLogState({ view: 'all', currency: 'INR' }, true);
    expect(state.title).toBe('No entries match these filters');
    expect(state.description).toContain('these filters leave out');
    expect(state.offerEverything).toBe(true);
  });

  it('writes no em dash', () => {
    for (const has of [true, false, null]) {
      for (const filters of [{ view: 'activity' }, { view: 'all', currency: 'INR' }, { view: 'all', cursor: '9' }] as const) {
        const state = emptyLogState(filters, has);
        expect(`${state.title} ${state.description}`).not.toContain(String.fromCharCode(0x2014));
      }
    }
  });
});

describe('emptyPageNeedsWholeLogRead', () => {
  it('is needed for a view or a filter, and not for the whole log or an older page', () => {
    expect(emptyPageNeedsWholeLogRead({ view: 'activity' })).toBe(true);
    expect(emptyPageNeedsWholeLogRead({ view: 'all', currency: 'INR' })).toBe(true);
    expect(emptyPageNeedsWholeLogRead({ view: 'all' })).toBe(false);
    expect(emptyPageNeedsWholeLogRead({ view: 'activity', cursor: '9' })).toBe(false);
  });
});

describe('the billing log page', () => {
  it('opens on a view with nothing in it, finds the log has an entry, and links to Everything', async () => {
    reply = (path) => (isWholeLogRead(path) ? { items: [ENTRY], nextCursor: null, actors: null } : { items: [], nextCursor: null, actors: null });
    const html = await render();

    expect(html).toContain('Nothing in this view');
    expect(html).toContain('The log has entries in other views.');
    expect(html).not.toContain('Nothing logged yet');
    expect(html).toContain('<a href="/applications/app_1/billing-log?view=all"');
    expect(html).toContain('Show everything');
    expect(requests).toHaveLength(2);
    expect(requests.filter(isWholeLogRead)).toHaveLength(1);
  });

  it('says nothing is logged yet when the log is empty', async () => {
    const html = await render();
    expect(html).toContain('Nothing logged yet');
    expect(html).not.toContain('Show everything');
    expect(requests.filter(isWholeLogRead)).toHaveLength(1);
  });

  it('makes no second read when the page has entries', async () => {
    reply = () => ({ items: [ENTRY], nextCursor: null, actors: null });
    const html = await render({ view: 'configuration' });
    expect(html).toContain('data-entries="1"');
    expect(requests).toHaveLength(1);
    expect(requests.filter(isWholeLogRead)).toEqual([]);
  });

  it('makes no second read for an empty Everything view: that page is the whole log', async () => {
    const html = await render({ view: 'all' });
    expect(html).toContain('Nothing logged yet');
    expect(requests).toHaveLength(1);
  });

  it('still shows the empty view when the second read fails', async () => {
    reply = (path) => (isWholeLogRead(path) ? new Error('down') : { items: [], nextCursor: null, actors: null });
    const html = await render();
    expect(html).toContain('Nothing in this view');
    expect(html).toContain('Other views may have entries.');
  });
});
