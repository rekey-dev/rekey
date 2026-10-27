/**
 * The command palette's end-user lookup proxies one application's end-user
 * search and degrades to an empty list on any API refusal.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: (...args: unknown[]) => api(...args) };
});

const { PanelApiError } = await import('@/lib/api');
const { GET } = await import('@/app/api/palette/end-users/route');

function request(query: string): NextRequest {
  return new NextRequest(`http://panel.test/api/palette/end-users?${query}`);
}

function user(n: number): Record<string, unknown> {
  return { id: `eu_${n}`, email: `user${n}@example.com`, emailVerified: true, role: 'user' };
}

beforeEach(() => {
  api.mockReset();
});

describe('GET /api/palette/end-users', () => {
  it('passes the search through to the application end-user list', async () => {
    api.mockResolvedValue({ items: [user(1)], total: 1, limit: 5, offset: 0 });
    const res = await GET(request('app=app_1&q=%20Ann%2Bx%40example.com%20'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'eu_1', email: 'user1@example.com' }]);
    const { path, redirectOn401, interruptOnAccessError } = api.mock.calls[0]?.[0] as Record<string, unknown>;
    const url = new URL(String(path), 'http://api.test');
    expect(url.pathname).toBe('/api/v1/tenant/applications/app_1/end-users');
    expect(url.searchParams.get('search')).toBe('Ann+x@example.com');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(redirectOn401).toBe(false);
    expect(interruptOnAccessError).toBe(false);
  });

  it('returns at most five results', async () => {
    api.mockResolvedValue({ items: [1, 2, 3, 4, 5, 6, 7].map(user), total: 7, limit: 7, offset: 0 });
    const body = (await (await GET(request('app=app_1&q=user'))).json()) as unknown[];
    expect(body).toHaveLength(5);
  });

  it('answers an empty list with the API status when the session is missing', async () => {
    api.mockRejectedValue(new PanelApiError({ code: 'UNAUTHORIZED', message: 'No session', statusCode: 401 }));
    const res = await GET(request('app=app_1&q=user'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual([]);
  });

  it('answers an empty list when the member has no grant on the application', async () => {
    api.mockRejectedValue(new PanelApiError({ code: 'FORBIDDEN', message: 'No access', statusCode: 403 }));
    const res = await GET(request('app=app_1&q=user'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual([]);
  });

  it('does not call the API without an application or a query', async () => {
    expect(await (await GET(request('q=user'))).json()).toEqual([]);
    expect(await (await GET(request('app=app_1&q=%20'))).json()).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});
