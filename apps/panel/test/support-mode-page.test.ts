/**
 * The Application's Support mode page: the catalogue controls are for
 * operators who can write, and a failed read is not shown as an empty list.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CAPABILITY_NAME_PATTERN, caseAgeLabel } from '../src/lib/support-mode';
import { ALL_SCOPES } from './all-scopes';

const CASE = {
  id: 'case_1',
  applicationId: 'app_1',
  endUserId: 'eu_1',
  endUserEmail: 'ada@example.org',
  status: 'OPEN',
  capabilities: ['diagnostics.debug'],
  scope: 'DEVICES',
  deviceIds: ['dev_1', 'dev_2'],
  reason: 'Ticket 1423: export fails on one PC',
  openedBy: 'op_1',
  openedByEmail: 'grace@example.org',
  openedAt: '2026-10-01T09:30:00.000Z',
  updatedAt: '2026-10-01T09:30:00.000Z',
  closedBy: null,
  closedByEmail: null,
  closedAt: null,
  closedCause: null,
};

let scopes: string[] | null = null;
let cases: unknown = null;
let catalogue: unknown = [];
const reads: string[] = [];

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock('@/components/Link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));
vi.mock('@/lib/support-mode', async (orig) => ({
  ...(await orig<object>()),
  getSupportCapabilities: async () => catalogue,
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<object>()),
  readErrorFlash: async () => ({}),
  getApplication: async () => ({
    id: 'app_1',
    access: { level: 'read', scopes: scopes ?? ALL_SCOPES },
  }),
  apiGet: async (path: string) => {
    reads.push(path);
    if (cases === null) throw new Error('unreachable');
    return cases;
  },
}));

async function render(searchParams: Record<string, string> = {}): Promise<{ html: string; text: string }> {
  const { default: Page } = await import('@/app/(authed)/applications/[id]/support/page');
  const tree = await Page({
    params: Promise.resolve({ id: 'app_1' }),
    searchParams: Promise.resolve(searchParams),
  });
  const html = renderToStaticMarkup(tree);
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

beforeEach(() => {
  scopes = null;
  cases = { items: [CASE], page: { total: 1, limit: 25, offset: 0, hasMore: false } };
  catalogue = [
    { id: 'cap_1', applicationId: 'app_1', name: 'diagnostics.debug', description: null, createdAt: '', updatedAt: '' },
  ];
  reads.length = 0;
});

describe('Application Support mode page', () => {
  it('shows a writer each open case with its reason, and the catalogue controls', async () => {
    scopes = ['end-users:read', 'end-users:write'];
    const { html, text } = await render();
    expect(html).toContain('href="/applications/app_1/end-users/eu_1/support-mode"');
    expect(text).toContain('ada@example.org');
    expect(text).toContain('2 devices');
    expect(text).toContain('grace@example.org');
    expect(text).toContain('Ticket 1423');
    expect(text).toContain('New capability');
    expect(text).toContain('Delete');
    expect(reads[0]).toContain('/support-cases?status=open&');
  });

  it('shows a reader the reason the API returns to them, and no catalogue controls', async () => {
    scopes = ['end-users:read'];
    const { html, text } = await render();
    expect(text).toContain('ada@example.org');
    expect(text).toContain('diagnostics.debug');
    expect(text).toContain('Ticket 1423');
    expect(text).not.toContain('New capability');
    expect(html).not.toContain('<form');
  });

  it('asks for closed cases when the filter says so', async () => {
    cases = {
      items: [{ ...CASE, status: 'CLOSED', closedAt: '2026-10-05T00:00:00Z', closedCause: 'banned' }],
      page: { total: 1, limit: 25, offset: 0, hasMore: false },
    };
    const { text } = await render({ status: 'closed' });
    expect(reads[0]).toContain('status=closed');
    expect(text).toContain('end-user banned');
  });

  it('does not show a failed read as an empty list', async () => {
    cases = null;
    catalogue = null;
    const { text } = await render();
    expect(text).not.toContain('No account is in support mode');
    expect(text).not.toContain('No capabilities yet');
    expect(text.match(/could not be read/g)?.length).toBe(2);
  });
});

describe('capability name pattern', () => {
  it('compiles under the v flag, which is how the browser reads a pattern attribute', () => {
    expect(() => new RegExp(CAPABILITY_NAME_PATTERN, 'v')).not.toThrow();
  });
});

describe('caseAgeLabel', () => {
  it('counts whole days', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    expect(caseAgeLabel('2026-10-11T09:00:00Z', now)).toBe('today');
    expect(caseAgeLabel('2026-10-10T09:00:00Z', now)).toBe('1 day');
    expect(caseAgeLabel('2026-09-11T09:00:00Z', now)).toBe('30 days');
  });
});
