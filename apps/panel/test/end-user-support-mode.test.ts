/**
 * The end-user Support mode tab: what a writer, a reader and a failed read
 * each get, and that an empty catalogue points at where to fill it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const OPEN_CASE = {
  id: 'case_1',
  applicationId: 'app_1',
  endUserId: 'eu_1',
  endUserEmail: 'ada@example.org',
  status: 'OPEN',
  capabilities: ['diagnostics.debug', 'prerelease_builds'],
  scope: 'DEVICES',
  deviceIds: ['dev_1'],
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

const CATALOGUE = [
  { id: 'cap_1', applicationId: 'app_1', name: 'diagnostics.debug', description: 'Full debug export', createdAt: '', updatedAt: '' },
  { id: 'cap_2', applicationId: 'app_1', name: 'prerelease_builds', description: null, createdAt: '', updatedAt: '' },
];

let scopes: string[] | null = null;
let support: unknown = null;
let catalogue: unknown = CATALOGUE;
let bannedAt: string | null = null;

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
vi.mock('@/app/(authed)/applications/[id]/end-users/[euid]/actions', () => {
  const noop = async (): Promise<void> => undefined;
  return { openSupportCase: noop, changeSupportCase: noop, endSupportCase: noop, addSupportCaseNote: noop };
});
vi.mock('@/app/(authed)/applications/[id]/end-users/[euid]/shared', async (orig) => ({
  ...(await orig<object>()),
  getEndUserDetail: async () => ({
    endUser: { id: 'eu_1', email: 'ada@example.org', erasedAt: null, bannedAt },
  }),
  getEndUserSupport: async () => support,
  getEndUserDevices: async () => ({
    items: [
      { id: 'dev_1', label: 'Studio PC', fingerprint: 'fp-1', status: 'ACTIVE', lastSeenAt: '2026-10-10T00:00:00Z' },
      { id: 'dev_2', label: null, fingerprint: 'fp-2', status: 'RELEASED', lastSeenAt: '2026-09-01T00:00:00Z' },
    ],
    page: { total: 2, limit: 100, offset: 0, hasMore: false },
  }),
}));
vi.mock('@/lib/support-mode', async (orig) => ({
  ...(await orig<object>()),
  getSupportCapabilities: async () => catalogue,
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<object>()),
  getApplication: async () => ({
    id: 'app_1',
    access: scopes === null ? undefined : { level: 'read', scopes },
  }),
}));

async function render(searchParams: Record<string, string> = {}): Promise<{ html: string; text: string }> {
  const { default: Page } = await import(
    '@/app/(authed)/applications/[id]/end-users/[euid]/support-mode/page'
  );
  const tree = await Page({
    params: Promise.resolve({ id: 'app_1', euid: 'eu_1' }),
    searchParams: Promise.resolve(searchParams),
  });
  const html = renderToStaticMarkup(tree);
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

beforeEach(() => {
  scopes = null;
  support = { open: null, history: [], events: [] };
  catalogue = CATALOGUE;
  bannedAt = null;
});

describe('end-user Support mode tab', () => {
  it('shows a writer the open case, its capabilities and the End control', async () => {
    scopes = ['end-users:read', 'end-users:write'];
    support = { open: OPEN_CASE, history: [], events: [] };
    const { text } = await render();
    expect(text).toContain('diagnostics.debug');
    expect(text).toContain('prerelease_builds');
    expect(text).toContain('Studio PC');
    expect(text).toContain('Ticket 1423');
    expect(text).toContain('grace@example.org');
    expect(text).toContain('End support mode');
    expect(text).toContain('Save changes');
    expect(text).not.toContain('Open support case');
  });

  it('pre-fills the Change form from the open case and offers only active devices', async () => {
    support = { open: OPEN_CASE, history: [], events: [] };
    const { html } = await render();
    const checked = (name: string, value: string): boolean =>
      (html.match(/<input[^>]*>/g) ?? []).some(
        (tag) => tag.includes(`name="${name}"`) && tag.includes(`value="${value}"`) && tag.includes('checked'),
      );
    expect(checked('capabilities', 'diagnostics.debug')).toBe(true);
    expect(checked('scope', 'DEVICES')).toBe(true);
    expect(checked('scope', 'USER')).toBe(false);
    expect(checked('deviceIds', 'dev_1')).toBe(true);
    expect(html).not.toContain('value="dev_2"');
    expect(html).not.toContain('name="reason"');
  });

  it('shows a reader the state and the reason the API returns to them, and no controls', async () => {
    scopes = ['end-users:read'];
    support = { open: OPEN_CASE, history: [{ ...OPEN_CASE, id: 'case_0', status: 'CLOSED', closedCause: 'operator' }], events: [] };
    const { html, text } = await render();
    expect(text).toContain('diagnostics.debug');
    expect(text).not.toContain('End support mode');
    expect(text).not.toContain('Save changes');
    expect(text).not.toContain('Open support case');
    expect(text.match(/Ticket 1423/g)).toHaveLength(2);
    expect(html).not.toContain('<form');
  });

  it('offers a writer the open form, with the reason hint, when no case is open', async () => {
    const { html, text } = await render();
    expect(text).toContain('Open support case');
    expect(text).toContain('Only operators see it');
    expect(html).toMatch(/<textarea[^>]*name="reason"[^>]*required/);
    expect(text).not.toContain('End support mode');
  });

  it('says the state could not be read, and not that support mode is off', async () => {
    support = null;
    const { html, text } = await render();
    expect(text).toContain('could not be read');
    expect(text).not.toContain('No support case is open');
    expect(html).not.toContain('<form');
  });

  it('links to the catalogue instead of showing a form when it is empty', async () => {
    catalogue = [];
    const { html, text } = await render();
    expect(text).toContain('No capabilities to turn on yet');
    expect(html).toContain('href="/applications/app_1/support"');
    expect(html).not.toContain('<form');
  });

  it('does not offer a banned end-user a case', async () => {
    bannedAt = '2026-10-02T00:00:00Z';
    const { html, text } = await render();
    expect(text).toContain('A banned end-user cannot get a support case');
    expect(html).not.toContain('<form');
  });

  it('never renders an error code from the URL', async () => {
    const { text } = await render({ caseError: 'Call 555 to restore access' });
    expect(text).not.toContain('Call 555');
    expect((await render({ caseError: 'SUPPORT_CASE_ALREADY_OPEN' })).text).toContain('already has an open support case');
  });

  it('lists what happened with capabilities before and after', async () => {
    support = {
      open: null,
      history: [],
      events: [
        {
          id: 'ev_1',
          type: 'end_user.support_updated',
          actorEmail: 'grace@example.org',
          createdAt: '2026-10-03T00:00:00Z',
          metadata: { capabilitiesBefore: ['diagnostics.debug'], capabilitiesAfter: ['prerelease_builds'] },
        },
      ],
    };
    const { text } = await render();
    expect(text).toMatch(/changed .*grace@example\.org .*diagnostics\.debug .*prerelease_builds/);
  });

  it('shows the notes of the open case and of past cases, and the note form to a writer only', async () => {
    const note = (id: string, body: string) => ({
      id,
      body,
      authorId: 'op_1',
      authorEmail: 'grace@example.org',
      createdAt: '2026-10-02T10:00:00.000Z',
    });
    support = {
      open: { ...OPEN_CASE, notes: [note('n_2', 'Sent build 4.2.1')] },
      history: [
        {
          ...OPEN_CASE,
          id: 'case_0',
          status: 'CLOSED',
          closedCause: 'operator',
          reason: 'Ticket 1200: crash on launch',
          notes: [note('n_1', 'Safe mode fixed it')],
        },
      ],
      events: [],
    };
    scopes = ['end-users:read', 'end-users:write'];
    const writer = await render();
    expect(writer.text).toContain('Sent build 4.2.1');
    expect(writer.text).toContain('Ticket 1200: crash on launch');
    expect(writer.text).toContain('Safe mode fixed it');
    expect(writer.html).toMatch(/<textarea[^>]*name="body"[^>]*maxLength="2000"/i);
    expect(writer.text).toContain('Add note');

    scopes = ['end-users:read'];
    const reader = await render();
    expect(reader.text).toContain('Sent build 4.2.1');
    expect(reader.text).toContain('Safe mode fixed it');
    expect(reader.html).not.toContain('name="body"');
    expect(reader.html).not.toContain('<form');
    expect((await render({ caseError: 'SUPPORT_NOTE_INVALID' })).text).toContain('Write a note of up to 2000 characters');
  });

  it('shows the capabilities of an opened event as after and of a closed event as before', async () => {
    const event = { actorEmail: 'grace@example.org', metadata: { capabilities: ['diagnostics.debug'] } };
    support = {
      open: null,
      history: [],
      events: [
        { ...event, id: 'ev_2', type: 'end_user.support_closed', createdAt: '2026-10-04T00:00:00Z' },
        { ...event, id: 'ev_1', type: 'end_user.support_opened', createdAt: '2026-10-02T00:00:00Z' },
      ],
    };
    const { html } = await render();
    const cells = (html.match(/<tr[\s\S]*?<\/tr>/g) ?? [])
      .filter((row) => row.includes('grace@example.org'))
      .map((row) => (row.match(/<td[\s\S]*?<\/td>/g) ?? []).map((cell) => cell.includes('diagnostics.debug')));
    // Columns: action, by, capabilities before, capabilities after, when.
    expect(cells).toEqual([
      [false, false, true, false, false],
      [false, false, false, true, false],
    ]);
  });
});
