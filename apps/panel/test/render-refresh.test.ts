/**
 * A render never spends the refresh token.
 *
 * The refresh token is single-use and rotates on every exchange; the API reads
 * a replay of a rotated token as theft and revokes every session the operator
 * has, on every device. A Server Component cannot write cookies, so a render
 * that refreshed spent the token, lost the replacement, and left the browser
 * to replay the spent one on its next request. These tests pin the fix:
 *
 *   - a render with a dead access token calls NO refresh endpoint and
 *     redirects to `/session/refresh` with its own path as `next`;
 *   - that route rotates and writes both cookies onto its redirect;
 *   - `next` only ever resolves to a same-origin path;
 *   - a token the route minted moments ago is not sent round again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

interface Cookie { value: string }

class FakeJar {
  private readonly store = new Map<string, Cookie>();
  /** A Server Component: Next forbids writes. */
  public readOnly = false;
  get(name: string): Cookie | undefined {
    return this.store.get(name);
  }
  set(name: string, value: string): void {
    if (this.readOnly) throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
    this.store.set(name, { value });
  }
  delete(name: string): void {
    if (this.readOnly) throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
    this.store.delete(name);
  }
  seed(name: string, value: string): void {
    this.store.set(name, { value });
  }
  clear(): void {
    this.store.clear();
  }
}

const jar = new FakeJar();
let requestHeaders = new Headers();

vi.mock('next/headers', () => ({
  cookies: async () => jar,
  headers: async () => requestHeaders,
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  forbidden: () => {
    throw new Error('NEXT_FORBIDDEN');
  },
}));

let refreshCalls = 0;
/** Refresh tokens the fake API has already rotated. Presenting one again is the cascade. */
const spent = new Set<string>();
let replays = 0;
/** Tokens the fake API answers with `REFRESH_TOKEN_RACED`: rotated moments ago elsewhere. */
const raced = new Set<string>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An unsigned JWT with the given claims; the panel only ever reads it unverified. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

const now = () => Math.floor(Date.now() / 1000);
const EXPIRED_ACCESS = jwt({ typ: 'to_access', sub: 'u1', iat: now() - 3600, exp: now() - 2700 });

beforeEach(() => {
  process.env.REKEY_URL = 'https://api.test';
  refreshCalls = 0;
  replays = 0;
  spent.clear();
  raced.clear();
  jar.clear();
  jar.readOnly = false;
  jar.seed('rekey_access', EXPIRED_ACCESS);
  jar.seed('rekey_refresh', 'refresh-1');
  requestHeaders = new Headers({ 'x-rekey-return-to': '/applications/app_1/keys?tab=live' });

  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    if (href.endsWith('/api/v1/tenant/auth/refresh')) {
      refreshCalls += 1;
      const presented = (JSON.parse(String(init?.body)) as { refreshToken: string }).refreshToken;
      if (raced.has(presented)) {
        return jsonResponse(401, { success: false, error: { code: 'REFRESH_TOKEN_RACED', message: 'raced' } });
      }
      if (spent.has(presented)) {
        replays += 1;
        return jsonResponse(401, { success: false, error: { code: 'REFRESH_TOKEN_REUSED', message: 'replay' } });
      }
      spent.add(presented);
      return jsonResponse(200, {
        success: true,
        data: {
          accessToken: jwt({ typ: 'to_access', sub: 'u1', iat: now(), exp: now() + 900 }),
          refreshToken: `${presented}-next`,
        },
      });
    }
    const auth = new Headers(init?.headers as HeadersInit).get('authorization') ?? '';
    const token = auth.replace(/^Bearer /, '');
    if (!token || token === EXPIRED_ACCESS) {
      return jsonResponse(401, { success: false, error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
    }
    return jsonResponse(200, { success: true, data: { ok: true } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('api() during a render', () => {
  it('does not call the refresh endpoint, and redirects to the refresh route with its own path', async () => {
    jar.readOnly = true;
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/api/v1/tenant/applications' })).rejects.toThrow(
      'NEXT_REDIRECT:/session/refresh?next=%2Fapplications%2Fapp_1%2Fkeys%3Ftab%3Dlive',
    );
    expect(refreshCalls).toBe(0);
    // The token the browser holds is still the live one.
    expect(jar.get('rekey_refresh')?.value).toBe('refresh-1');
  });

  it('redirects the same way when the access cookie is gone entirely', async () => {
    jar.readOnly = true;
    jar.seed('rekey_access', '');
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/x' })).rejects.toThrow(/NEXT_REDIRECT:\/session\/refresh\?next=/);
    expect(refreshCalls).toBe(0);
  });

  it('does not send a token minted moments ago round again: that would loop', async () => {
    jar.readOnly = true;
    const fresh = jwt({ typ: 'to_access', sub: 'u1', iat: now() - 5, exp: now() + 895 });
    jar.seed('rekey_access', fresh);
    vi.stubGlobal('fetch', async (url: string | URL): Promise<Response> => {
      if (String(url).endsWith('/auth/refresh')) refreshCalls += 1;
      return jsonResponse(401, { success: false, error: { code: 'USER_TOKEN_INVALID', message: 'no' } });
    });
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/x' })).rejects.toThrow('NEXT_REDIRECT:/sign-out?reason=expired');
    expect(refreshCalls).toBe(0);
  });

  it('never turns a forged return-to header into an off-site redirect', async () => {
    jar.readOnly = true;
    requestHeaders = new Headers({ 'x-rekey-return-to': '//evil.example/phish' });
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/x' })).rejects.toThrow(/^NEXT_REDIRECT:\/session\/refresh\?next=%2F$/);
  });
});

describe('api() in a Server Action', () => {
  it('still refreshes in place, writes the new pair, and retries', async () => {
    const { api } = await import('@/lib/api');

    await expect(api<{ ok: boolean }>({ method: 'POST', path: '/x', body: {} })).resolves.toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(jar.get('rekey_refresh')?.value).toBe('refresh-1-next');
  });
});

/** What undici's `fetch` throws when the socket failed with `code`. */
function connectFailure(code: string): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`connect ${code}`), { code }),
  });
}

/** Node tries ::1 and 127.0.0.1 for `localhost` and reports both refusals together. */
function localhostRefused(): TypeError {
  const both = new AggregateError(
    [
      Object.assign(new Error('connect ECONNREFUSED ::1:3030'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3030'), { code: 'ECONNREFUSED' }),
    ],
    '',
  );
  return Object.assign(new TypeError('fetch failed'), { cause: both });
}

function refreshRequest(next: string, cookie = 'rekey_access=; rekey_refresh=refresh-1'): NextRequest {
  return new NextRequest(`https://panel.test/session/refresh?next=${encodeURIComponent(next)}`, {
    headers: { cookie },
  });
}

describe('GET /session/refresh', () => {
  it('rotates once, sets both cookies on the redirect, and returns to next', async () => {
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/applications/app_1/keys?tab=live'));

    expect(refreshCalls).toBe(1);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/applications/app_1/keys?tab=live');
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/rekey_refresh=refresh-1-next;/);
    expect(setCookie).toMatch(/rekey_access=ey[^;]+;/);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it.each([
    ['//evil.example/x'],
    ['https://evil.example/x'],
    ['/\t/evil.example'],
    ['/\\evil.example'],
    ['/..//evil.example'],
    ['/x/..//evil.example'],
    ['/./\\evil.example'],
    ['/%2e%2e//evil.example'],
    ['javascript:alert(1)'],
    ['/session/refresh?next=/x'],
  ])('keeps an off-origin or looping next (%j) on the panel', async (next) => {
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest(next));

    const location = res.headers.get('location') ?? '';
    expect(new URL(location, 'https://panel.test').origin).toBe('https://panel.test');
    expect(location.startsWith('/session/refresh')).toBe(false);
  });

  it('a browser request that arrives after the rotation asks the API, and is never handed the new pair', async () => {
    const { GET } = await import('@/app/session/refresh/route');

    // Two prefetches sent with the old cookie; the second lands after the
    // first has already rotated.
    await GET(refreshRequest('/a'));
    // What the API says for a token it rotated moments ago.
    raced.add('refresh-1');
    const late = await GET(refreshRequest('/b'));

    expect(refreshCalls).toBe(2);
    expect(replays).toBe(0);
    expect(late.status).toBe(303);
    expect(late.headers.get('location')).toBe('/b');
    const set = late.headers.getSetCookie().join('\n');
    expect(set).not.toMatch(/rekey_refresh=refresh-1-next/);
    expect(set).not.toMatch(/rekey_access=/);
    expect(set).toMatch(/rekey_refresh_raced=[0-9a-f]{32};/);
  });

  it('concurrent requests with the same cookie share one exchange', async () => {
    const { GET } = await import('@/app/session/refresh/route');

    const [a, b] = await Promise.all([GET(refreshRequest('/a')), GET(refreshRequest('/b'))]);

    expect(refreshCalls).toBe(1);
    for (const res of [a, b]) expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_refresh=refresh-1-next;/);
  });

  it.each([502, 503, 504])('a proxy %i with no Rekey body keeps the cookies and answers 503', async (status) => {
    vi.stubGlobal('fetch', async () => new Response('<html>Bad Gateway</html>', { status }));
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/a'));

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  // Self-hosted, the panel talks to the API container directly with no proxy
  // in front, so a redeploy is a refused connection, not a 502.
  it.each([
    ['refused', connectFailure('ECONNREFUSED')],
    ['DNS not found', connectFailure('ENOTFOUND')],
    ['DNS try again', connectFailure('EAI_AGAIN')],
    ['connect timeout', connectFailure('UND_ERR_CONNECT_TIMEOUT')],
    ['refused on both localhost families', localhostRefused()],
  ])('a connection that was never made (%s) keeps the cookies and answers 503', async (_name, failure) => {
    vi.stubGlobal('fetch', async () => {
      throw failure;
    });
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/a'));

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('a connection dropped after it was made still counts as maybe spent', async () => {
    vi.stubGlobal('fetch', async () => {
      throw connectFailure('ECONNRESET');
    });
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/a'));

    expect(res.headers.get('location')).toBe('/login?reason=session_interrupted&next=%2Fa');
    expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_refresh=;/);
  });

  it('a 503 the API answered itself clears the session and says it was interrupted', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(503, { success: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'down' } }),
    );
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/a'));

    expect(res.headers.get('location')).toBe('/login?reason=session_interrupted&next=%2Fa');
    expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_refresh=;/);
  });

  it.each(['cross-site', 'same-site'])('a %s request gets the interstitial: no API call, no cookie', async (site) => {
    const { GET } = await import('@/app/session/refresh/route');
    const req = new NextRequest('https://panel.test/session/refresh?next=%2Fa', {
      headers: { cookie: 'rekey_access=; rekey_refresh=refresh-1', 'sec-fetch-site': site },
    });

    const res = await GET(req);

    expect(refreshCalls).toBe(0);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain('content="0;url=/session/refresh?next=%2Fa"');
    expect(html).not.toContain('<script');
  });

  it.each(['same-origin', 'none'])('a %s request rotates', async (site) => {
    const { GET } = await import('@/app/session/refresh/route');
    const req = new NextRequest('https://panel.test/session/refresh?next=%2Fa', {
      headers: { cookie: 'rekey_access=; rekey_refresh=refresh-1', 'sec-fetch-site': site },
    });

    const res = await GET(req);

    expect(refreshCalls).toBe(1);
    expect(res.status).toBe(303);
  });

  it('clears the session and signs in again when the API refuses the token', async () => {
    spent.add('refresh-1');
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/a'));

    expect(res.headers.get('location')).toBe('/login?reason=expired&next=%2Fa');
    expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_refresh=;/);
  });

  it('touches nothing when the request carried no session', async () => {
    jar.clear();
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/a', ''));

    expect(refreshCalls).toBe(0);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

/**
 * `REFRESH_TOKEN_RACED`: another tab or panel instance rotated this token
 * moments ago and the API revoked nothing. The browser already holds (or is
 * about to hold) the winner's pair, so clearing the cookies here would delete
 * that pair and sign the operator out.
 */
describe('a raced refresh (REFRESH_TOKEN_RACED)', () => {
  it('route: goes back to next with the session cookies untouched, setting only the loop guard', async () => {
    raced.add('refresh-1');
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/applications?tab=keys'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/applications?tab=keys');
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some((c) => /^rekey_(access|refresh)=/.test(c))).toBe(false);
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(/^rekey_refresh_raced=[0-9a-f]{32};/);
    expect(setCookie[0]).not.toContain('refresh-1');
  });

  it('route: the same token racing a second time signs in again instead of looping', async () => {
    raced.add('refresh-1');
    const { GET } = await import('@/app/session/refresh/route');
    const first = await GET(refreshRequest('/a'));
    const mark = /^rekey_refresh_raced=([^;]+);/.exec(first.headers.getSetCookie()[0] ?? '')?.[1] ?? '';
    // The browser comes back still holding the spent token, and the mark.
    jar.seed('rekey_refresh_raced', mark);

    const second = await GET(refreshRequest('/a'));

    expect(second.headers.get('location')).toBe('/login?reason=expired&next=%2Fa');
    expect(second.headers.getSetCookie().join('\n')).toMatch(/rekey_refresh=;/);
  });

  it('route: a mark left by a different token does not count as a repeat', async () => {
    raced.add('refresh-1');
    const { racedMark } = await import('@/lib/session-refresh');
    jar.seed('rekey_refresh_raced', await racedMark('some-older-token'));
    const { GET } = await import('@/app/session/refresh/route');

    const res = await GET(refreshRequest('/a'));

    expect(res.headers.get('location')).toBe('/a');
    expect(res.headers.getSetCookie().some((c) => /^rekey_(access|refresh)=/.test(c))).toBe(false);
  });

  it('route: every other refusal still clears the session', async () => {
    for (const code of ['REFRESH_TOKEN_REUSED', 'REFRESH_TOKEN_REVOKED', 'REFRESH_TOKEN_EXPIRED', 'REFRESH_TOKEN_SOMETHING_NEW']) {
      vi.stubGlobal('fetch', async () => jsonResponse(401, { success: false, error: { code, message: 'no' } }));
      vi.resetModules();
      const { GET } = await import('@/app/session/refresh/route');

      const res = await GET(refreshRequest('/a'));

      expect(res.headers.get('location'), code).toBe('/login?reason=expired&next=%2Fa');
      expect(res.headers.getSetCookie().join('\n'), code).toMatch(/rekey_refresh=;/);
    }
  });

  it('Server Action: a retryable busy error, the session cookies untouched', async () => {
    raced.add('refresh-1');
    const { api, isApiBusy } = await import('@/lib/api');

    const err = await api({ method: 'POST', path: '/x', body: {} }).catch((e: unknown) => e);

    expect(isApiBusy(err)).toBe(true);
    expect((err as { code: string }).code).toBe('REFRESH_TOKEN_RACED');
    expect(jar.get('rekey_refresh')?.value).toBe('refresh-1');
    expect(jar.get('rekey_access')?.value).toBe(EXPIRED_ACCESS);
    expect(jar.get('rekey_refresh_raced')?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('Server Action: the retry racing again signs out rather than failing forever', async () => {
    raced.add('refresh-1');
    const { api } = await import('@/lib/api');
    await api({ method: 'POST', path: '/x', body: {} }).catch(() => undefined);

    await expect(api({ method: 'POST', path: '/x', body: {} })).rejects.toThrow('NEXT_REDIRECT:/login?reason=expired');
    expect(jar.get('rekey_refresh')).toBeUndefined();
  });
});

describe('the middleware check', () => {
  it('sends a page load with only a refresh cookie through the refresh route', async () => {
    const { staleSessionRedirect } = await import('@/lib/session-refresh');
    const base = {
      method: 'GET',
      url: new URL('https://panel.test/applications?tab=keys&_rsc=abc'),
      hasAccess: false,
      hasRefresh: true,
    };

    expect(staleSessionRedirect(base)).toBe('/session/refresh?next=%2Fapplications%3Ftab%3Dkeys');
    expect(staleSessionRedirect({ ...base, hasAccess: true })).toBeNull();
    expect(staleSessionRedirect({ ...base, hasRefresh: false })).toBeNull();
    // A Server Action (a POST) refreshes in place; redirecting it would drop it.
    expect(staleSessionRedirect({ ...base, method: 'POST' })).toBeNull();
    for (const path of ['/session/refresh', '/sign-out', '/login', '/login/magic-link', '/api/check-slug']) {
      expect(staleSessionRedirect({ ...base, url: new URL(`https://panel.test${path}`) })).toBeNull();
    }
  });

  it('marks its redirect uncacheable: it depends on the cookies, not the URL', async () => {
    const { middleware } = await import('@/middleware');

    const res = middleware(
      new NextRequest('https://panel.test/applications', { headers: { cookie: 'rekey_refresh=refresh-1' } }),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('redirects a document load but lets a script fetch (an RSC navigation) through', async () => {
    const { middleware } = await import('@/middleware');
    const request = (dest: string) =>
      new NextRequest('https://panel.test/applications', {
        headers: { cookie: 'rekey_refresh=refresh-1', 'sec-fetch-dest': dest },
      });

    // What the middleware actually receives for a client-side navigation: no
    // `RSC` header and no `_rsc` (Next strips both), only the browser's own
    // `Sec-Fetch-Dest: empty`. Redirecting it would end in an RSC payload at
    // the bare page URL; the page's own `api()` call redirects instead.
    expect(middleware(request('empty')).headers.get('location')).toBeNull();
    expect(middleware(request('document')).status).toBe(307);
  });
});
