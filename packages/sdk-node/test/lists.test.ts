/**
 * `rekey.lists` against a fake API: the requests it makes and how it pages.
 */

import { describe, expect, it, vi } from 'vitest';
import { Rekey } from '../src/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetchImpl: typeof fetch): Rekey {
  return new Rekey({ apiUrl: 'https://api.example.com', secretKey: 'rp_live_token', fetch: fetchImpl });
}

const member = (email: string) => ({
  contactId: `c_${email}`,
  email,
  name: null,
  status: 'subscribed',
  source: 'secret',
  consentVersion: null,
  consentAt: null,
  subscribedAt: '2026-09-29T00:00:00.000Z',
  unsubscribedAt: null,
  updatedAt: '2026-09-29T00:00:00.000Z',
});

describe('rekey.lists', () => {
  it('subscribes with the body as given and the visitor address from with({ clientIp })', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { status: 'subscribed', contactId: 'c1' } }));
    const result = await client(fetchSpy as unknown as typeof fetch)
      .with({ clientIp: '203.0.113.9' })
      .lists.subscribe('wait list', { email: 'ada@example.com', consent: { granted: true, version: 2 } });
    expect(result).toEqual({ status: 'subscribed', contactId: 'c1' });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/lists/wait%20list/subscribe');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Rekey-Client-Ip']).toBe('203.0.113.9');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'ada@example.com', consent: { granted: true, version: 2 } });
  });

  it('marks a relayed browser subscribe with X-Rekey-Relay, and only then', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => jsonResponse(202, { success: true, data: { status: 'received' } }));
    const rekey = client(fetchSpy as unknown as typeof fetch);
    await rekey.lists.subscribe('news', { email: 'a@example.com' }, { relay: 'browser' });
    await rekey.lists.subscribe('news', { email: 'b@example.com' });
    const headers = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>);
    expect(headers[0]!['X-Rekey-Relay']).toBe('browser');
    expect(headers[1]!['X-Rekey-Relay']).toBeUndefined();
  });

  it('reads the form and unsubscribes by address', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { key: 'news', name: 'News' } }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { status: 'unsubscribed' } }));
    const rekey = client(fetchSpy as unknown as typeof fetch);
    expect((await rekey.lists.get('news')).key).toBe('news');
    expect(await rekey.lists.unsubscribe('news', 'a+b@example.com')).toEqual({ status: 'unsubscribed' });
    const [url, init] = fetchSpy.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/lists/news/members/a%2Bb%40example.com');
    expect(init.method).toBe('DELETE');
  });

  it('iterateMembers follows cursors and passes the filters on every page', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { items: [member('a@x.com'), member('b@x.com')], nextCursor: 'CUR' } }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { items: [member('c@x.com')], nextCursor: null } }));
    const rekey = client(fetchSpy as unknown as typeof fetch);
    const emails: string[] = [];
    for await (const m of rekey.lists.iterateMembers('news', {
      status: 'all',
      updatedSince: new Date('2026-09-01T00:00:00.000Z'),
      limit: 2,
    })) {
      emails.push(m.email);
    }
    expect(emails).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      'https://api.example.com/api/v1/lists/news/members?status=all&updatedSince=2026-09-01T00%3A00%3A00.000Z&limit=2',
      'https://api.example.com/api/v1/lists/news/members?status=all&updatedSince=2026-09-01T00%3A00%3A00.000Z&cursor=CUR&limit=2',
    ]);
  });
});
