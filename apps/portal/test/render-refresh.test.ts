/**
 * A portal render never spends the refresh token.
 *
 * The end-user refresh token is single-use and rotates on every exchange; the
 * API reads a replay of a rotated token as theft and revokes every session the
 * customer has. `getPortalUser` runs in `[slug]/layout.tsx`, a Server
 * Component, which cannot write cookies: it used to refresh anyway, swallow the
 * failed cookie write, and leave the browser holding the spent token for its
 * next request to replay. These tests pin the fix:
 *
 *   - a render with a dead access token calls NO refresh endpoint and
 *     redirects to `/<slug>/session/refresh` with its own path as `next`;
 *   - that route rotates and writes both cookies, path-scoped, onto its
 *     redirect;
 *   - `next` only ever resolves to a same-origin path inside `/<slug>`.
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
}));

/** When set, the config lookup fails the way the API being down makes it fail. */
let configDown = false;

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return {
    ...actual,
    getPortalConfig: async (slug: string) => {
      if (configDown) throw new actual.PortalConfigUnavailableError(slug, 'HTTP 502', 7);
      return slug === 'acme' ? { publishableKey: 'rp_pub_test' } : null;
    },
  };
});

vi.mock('@/lib/env', () => ({ rekeyApiUrl: () => 'https://api.test' }));

let refreshCalls = 0;
let replays = 0;
const spent = new Set<string>();
/** Tokens the fake API answers with `REFRESH_TOKEN_RACED`: rotated moments ago elsewhere. */
const raced = new Set<string>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

const now = () => Math.floor(Date.now() / 1000);
const EXPIRED_ACCESS = jwt({ typ: 'eu_access', sub: 'eu_1', iat: now() - 3600, exp: now() - 2700 });
const USER = { id: 'eu_1', email: 'customer@example.com' };

beforeEach(() => {
  configDown = false;
  refreshCalls = 0;
  replays = 0;
  spent.clear();
  raced.clear();
  jar.clear();
  jar.readOnly = false;
  jar.seed('rekey_portal_access', EXPIRED_ACCESS);
  jar.seed('rekey_portal_refresh', 'refresh-1');
  requestHeaders = new Headers({ 'x-rekey-return-to': '/acme?tab=billing' });

  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    if (href.endsWith('/api/v1/auth/refresh')) {
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
          user: USER,
          accessToken: jwt({ typ: 'eu_access', sub: 'eu_1', iat: now(), exp: now() + 900 }),
          refreshToken: `${presented}-next`,
        },
      });
    }
    if (href.endsWith('/api/v1/auth/me')) {
      const token = new Headers(init?.headers as HeadersInit).get('x-rekey-user-token');
      if (!token || token === EXPIRED_ACCESS) {
        return jsonResponse(401, { success: false, error: { code: 'USER_TOKEN_INVALID', message: 'expired' } });
      }
      return jsonResponse(200, { success: true, data: USER });
    }
    return jsonResponse(404, { success: false, error: { code: 'NOT_FOUND', message: href } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('getPortalUser during a render', () => {
  it('does not call the refresh endpoint, and redirects to the refresh route with its own path', async () => {
    jar.readOnly = true;
    const { getPortalUser } = await import('@/lib/session');

    await expect(getPortalUser('acme')).rejects.toThrow(
      'NEXT_REDIRECT:/acme/session/refresh?next=%2Facme%3Ftab%3Dbilling',
    );
    expect(refreshCalls).toBe(0);
    expect(jar.get('rekey_portal_refresh')?.value).toBe('refresh-1');
  });

  it('does not send a token minted moments ago round again: that would loop', async () => {
    jar.readOnly = true;
    const fresh = jwt({ typ: 'eu_access', sub: 'eu_1', iat: now() - 5, exp: now() + 895 });
    jar.seed('rekey_portal_access', fresh);
    vi.stubGlobal('fetch', async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith('/auth/refresh')) refreshCalls += 1;
      return jsonResponse(401, { success: false, error: { code: 'USER_TOKEN_INVALID', message: 'no' } });
    });
    const { getPortalUser } = await import('@/lib/session');

    await expect(getPortalUser('acme')).resolves.toBeNull();
    expect(refreshCalls).toBe(0);
  });

  it('never turns a forged return-to header into a redirect off the app', async () => {
    jar.readOnly = true;
    requestHeaders = new Headers({ 'x-rekey-return-to': '/other-app/steal' });
    const { getPortalUser } = await import('@/lib/session');

    await expect(getPortalUser('acme')).rejects.toThrow(/^NEXT_REDIRECT:\/acme\/session\/refresh\?next=%2Facme$/);
  });

  it('a failed config lookup with a session goes to the refresh route, which keeps the cookies', async () => {
    jar.readOnly = true;
    configDown = true;
    const { getPortalConfigOrRefresh, getPortalUser } = await import('@/lib/session');

    const expected = 'NEXT_REDIRECT:/acme/session/refresh?next=%2Facme%3Ftab%3Dbilling';
    await expect(getPortalConfigOrRefresh('acme')).rejects.toThrow(expected);
    await expect(getPortalUser('acme')).rejects.toThrow(expected);
    expect(refreshCalls).toBe(0);
  });

  it('a failed config lookup without a session is left to the error page', async () => {
    jar.readOnly = true;
    configDown = true;
    jar.clear();
    const { getPortalConfigOrRefresh } = await import('@/lib/session');
    const { PortalConfigUnavailableError } = await import('@/lib/config');

    await expect(getPortalConfigOrRefresh('acme')).rejects.toBeInstanceOf(PortalConfigUnavailableError);
  });
});

describe('getPortalUser where cookies can be written', () => {
  it('refreshes in place and stores the new pair', async () => {
    const { getPortalUser } = await import('@/lib/session');

    const session = await getPortalUser('acme');

    expect(session?.user.email).toBe('customer@example.com');
    expect(refreshCalls).toBe(1);
    expect(jar.get('rekey_portal_refresh')?.value).toBe('refresh-1-next');
  });
});

function refreshRequest(next: string, cookie = 'rekey_portal_refresh=refresh-1'): NextRequest {
  return new NextRequest(`https://portal.test/acme/session/refresh?next=${encodeURIComponent(next)}`, {
    headers: { cookie },
  });
}

const ctx = { params: Promise.resolve({ slug: 'acme' }) };

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

describe('GET /<slug>/session/refresh', () => {
  it('rotates once, sets both cookies scoped to the app, and returns to next', async () => {
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme?tab=billing'), ctx);

    expect(refreshCalls).toBe(1);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/acme?tab=billing');
    const cookies = res.headers.getSetCookie();
    const refreshCookie = cookies.find((c) => c.startsWith('rekey_portal_refresh='));
    const accessCookie = cookies.find((c) => c.startsWith('rekey_portal_access='));
    expect(refreshCookie).toMatch(/^rekey_portal_refresh=refresh-1-next;/);
    expect(refreshCookie).toMatch(/Path=\/acme(;|$)/);
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(accessCookie).toMatch(/^rekey_portal_access=ey/);
  });

  it.each([
    ['//evil.example/x'],
    ['https://evil.example/x'],
    ['/\t/evil.example'],
    ['/\\evil.example'],
    ['/other-app'],
    ['/acme-lookalike/x'],
    ['/acme/session/refresh?next=/acme'],
  ])('keeps an off-app or looping next (%j) inside /acme', async (next) => {
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest(next), ctx);

    const location = res.headers.get('location') ?? '';
    const resolved = new URL(location, 'https://portal.test');
    expect(resolved.origin).toBe('https://portal.test');
    expect(resolved.pathname === '/acme' || resolved.pathname.startsWith('/acme/')).toBe(true);
    expect(resolved.pathname.startsWith('/acme/session/refresh')).toBe(false);
  });

  it('a browser request that arrives after the rotation asks the API, and is never handed the new pair', async () => {
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    await GET(refreshRequest('/acme'), ctx);
    // What the API says for a token it rotated moments ago.
    raced.add('refresh-1');
    const late = await GET(refreshRequest('/acme?x=1'), ctx);

    expect(refreshCalls).toBe(2);
    expect(replays).toBe(0);
    expect(late.status).toBe(303);
    expect(late.headers.get('location')).toBe('/acme?x=1');
    const set = late.headers.getSetCookie().join('\n');
    expect(set).not.toMatch(/rekey_portal_refresh=refresh-1-next/);
    expect(set).not.toMatch(/rekey_portal_access=/);
    expect(set).toMatch(/rekey_portal_refresh_raced=[0-9a-f]{32};/);
  });

  it('concurrent requests with the same cookie share one exchange', async () => {
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const [a, b] = await Promise.all([GET(refreshRequest('/acme'), ctx), GET(refreshRequest('/acme'), ctx)]);

    expect(refreshCalls).toBe(1);
    for (const res of [a, b]) {
      expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_portal_refresh=refresh-1-next;/);
    }
  });

  it.each([502, 503, 504])('a proxy %i with no Rekey body keeps the cookies and answers 503', async (status) => {
    vi.stubGlobal('fetch', async () => new Response('<html>Bad Gateway</html>', { status }));
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme'), ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('a failed config lookup answers the 503 retry page and keeps the cookies', async () => {
    configDown = true;
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme'), ctx);

    expect(refreshCalls).toBe(0);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

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
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme'), ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('a connection dropped after it was made still counts as maybe spent', async () => {
    vi.stubGlobal('fetch', async () => {
      throw connectFailure('ECONNRESET');
    });
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme'), ctx);

    expect(res.headers.get('location')).toBe('/acme/login?reason=session_interrupted');
    expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_portal_refresh=;/);
  });

  it('a 503 the API answered itself clears the session and says it was interrupted', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(503, { success: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'down' } }),
    );
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme'), ctx);

    expect(res.headers.get('location')).toBe('/acme/login?reason=session_interrupted');
    expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_portal_refresh=;/);
  });

  it.each(['cross-site', 'same-site'])('a %s request gets the interstitial: no API call, no cookie', async (site) => {
    const { GET } = await import('@/app/[slug]/session/refresh/route');
    const req = new NextRequest('https://portal.test/acme/session/refresh?next=%2Facme', {
      headers: { cookie: 'rekey_portal_refresh=refresh-1', 'sec-fetch-site': site },
    });

    const res = await GET(req, ctx);

    expect(refreshCalls).toBe(0);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain('content="0;url=/acme/session/refresh?next=%2Facme"');
    expect(html).not.toContain('<script');
  });

  it.each(['same-origin', 'none'])('a %s request rotates', async (site) => {
    const { GET } = await import('@/app/[slug]/session/refresh/route');
    const req = new NextRequest('https://portal.test/acme/session/refresh?next=%2Facme', {
      headers: { cookie: 'rekey_portal_refresh=refresh-1', 'sec-fetch-site': site },
    });

    const res = await GET(req, ctx);

    expect(refreshCalls).toBe(1);
    expect(res.status).toBe(303);
  });

  it('clears the session and signs in again when the API refuses the token', async () => {
    spent.add('refresh-1');
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme'), ctx);

    expect(res.headers.get('location')).toBe('/acme/login?reason=expired');
    expect(res.headers.getSetCookie().join('\n')).toMatch(/rekey_portal_refresh=;/);
  });

  it('touches nothing when the request carried no session', async () => {
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme', ''), ctx);

    expect(refreshCalls).toBe(0);
    expect(res.headers.get('location')).toBe('/acme/login');
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

/**
 * `REFRESH_TOKEN_RACED`: another tab or portal instance rotated this token
 * moments ago and the API revoked nothing. The browser already holds (or is
 * about to hold) the winner's pair, so clearing the cookies here would delete
 * that pair and sign the customer out.
 */
describe('a raced refresh (REFRESH_TOKEN_RACED)', () => {
  const touchesSession = (setCookie: string[]) => setCookie.some((c) => /^rekey_portal_(access|refresh)=/.test(c));

  it('route: goes back to next with the session cookies untouched, setting only the loop guard', async () => {
    raced.add('refresh-1');
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(refreshRequest('/acme?tab=billing'), ctx);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/acme?tab=billing');
    const setCookie = res.headers.getSetCookie();
    expect(touchesSession(setCookie)).toBe(false);
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(/^rekey_portal_refresh_raced=[0-9a-f]{32};/);
    expect(setCookie[0]).toMatch(/Path=\/acme(;|$)/);
    expect(setCookie[0]).not.toContain('refresh-1');
  });

  it('route: the same token racing a second time signs in again instead of looping', async () => {
    raced.add('refresh-1');
    const { GET } = await import('@/app/[slug]/session/refresh/route');
    const first = await GET(refreshRequest('/acme'), ctx);
    const mark = /^rekey_portal_refresh_raced=([^;]+);/.exec(first.headers.getSetCookie()[0] ?? '')?.[1] ?? '';

    // The browser comes back still holding the spent token, and the mark.
    const second = await GET(refreshRequest('/acme', `rekey_portal_refresh=refresh-1; rekey_portal_refresh_raced=${mark}`), ctx);

    expect(second.headers.get('location')).toBe('/acme/login?reason=expired');
    expect(second.headers.getSetCookie().join('\n')).toMatch(/rekey_portal_refresh=;/);
  });

  it('route: a mark left by a different token does not count as a repeat', async () => {
    raced.add('refresh-1');
    const { racedMark } = await import('@/lib/session-refresh');
    const { GET } = await import('@/app/[slug]/session/refresh/route');

    const res = await GET(
      refreshRequest('/acme', `rekey_portal_refresh=refresh-1; rekey_portal_refresh_raced=${await racedMark('older')}`),
      ctx,
    );

    expect(res.headers.get('location')).toBe('/acme');
    expect(touchesSession(res.headers.getSetCookie())).toBe(false);
  });

  it('route: every other refusal still clears the session', async () => {
    for (const code of ['REFRESH_TOKEN_REUSED', 'REFRESH_TOKEN_REVOKED', 'REFRESH_TOKEN_EXPIRED', 'REFRESH_TOKEN_SOMETHING_NEW']) {
      vi.stubGlobal('fetch', async () => jsonResponse(401, { success: false, error: { code, message: 'no' } }));
      vi.resetModules();
      const { GET } = await import('@/app/[slug]/session/refresh/route');

      const res = await GET(refreshRequest('/acme'), ctx);

      expect(res.headers.get('location'), code).toBe('/acme/login?reason=expired');
      expect(res.headers.getSetCookie().join('\n'), code).toMatch(/rekey_portal_refresh=;/);
    }
  });

  it('in place: signed out for this request only, the session cookies untouched', async () => {
    raced.add('refresh-1');
    const { getPortalUser } = await import('@/lib/session');

    await expect(getPortalUser('acme')).resolves.toBeNull();

    expect(jar.get('rekey_portal_refresh')?.value).toBe('refresh-1');
    expect(jar.get('rekey_portal_access')?.value).toBe(EXPIRED_ACCESS);
    expect(jar.get('rekey_portal_refresh_raced')?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('in place: the same token racing again clears the spent token rather than keeping it', async () => {
    raced.add('refresh-1');
    const first = await import('@/lib/session');
    await first.getPortalUser('acme');
    vi.resetModules(); // `getPortalUser` is cache()d per request; this is the next request
    const { getPortalUser } = await import('@/lib/session');

    await expect(getPortalUser('acme')).resolves.toBeNull();

    expect(jar.get('rekey_portal_refresh')?.value).toBe('');
  });
});

describe('the middleware check', () => {
  it('sends a page load with only a refresh cookie through the app refresh route', async () => {
    const { staleSessionRedirect } = await import('@/lib/session-refresh');
    const base = {
      method: 'GET',
      url: new URL('https://portal.test/acme?tab=billing&_rsc=1'),
      hasAccess: false,
      hasRefresh: true,
    };

    expect(staleSessionRedirect(base)).toBe('/acme/session/refresh?next=%2Facme%3Ftab%3Dbilling');
    expect(staleSessionRedirect({ ...base, hasAccess: true })).toBeNull();
    expect(staleSessionRedirect({ ...base, hasRefresh: false })).toBeNull();
    // A Server Action (a POST) refreshes in place; redirecting it would drop it.
    expect(staleSessionRedirect({ ...base, method: 'POST' })).toBeNull();
    expect(
      staleSessionRedirect({ ...base, url: new URL('https://portal.test/acme/session/refresh?next=/acme') }),
    ).toBeNull();
  });

  it('marks its redirect uncacheable: it depends on the cookies, not the URL', async () => {
    const { middleware } = await import('@/middleware');

    const res = middleware(
      new NextRequest('https://portal.test/acme', { headers: { cookie: 'rekey_portal_refresh=refresh-1' } }),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('redirects a document load but lets a script fetch (an RSC navigation) through', async () => {
    const { middleware } = await import('@/middleware');
    const request = (dest: string) =>
      new NextRequest('https://portal.test/acme', {
        headers: { cookie: 'rekey_portal_refresh=refresh-1', 'sec-fetch-dest': dest },
      });

    // What the middleware actually receives for a client-side navigation: no
    // `RSC` header and no `_rsc` (Next strips both), only the browser's own
    // `Sec-Fetch-Dest: empty`. Redirecting it would end in an RSC payload at
    // the bare page URL; `getPortalUser` redirects from the render instead.
    expect(middleware(request('empty')).headers.get('location')).toBeNull();
    expect(middleware(request('document')).status).toBe(307);
  });
});

describe('redirect targets after URL normalisation', () => {
  // Each passes a naive input check and only escapes once the URL parser has
  // collapsed its dot-segments or turned `\` into `/`.
  it.each([
    ['/..//evil.com'],
    ['/x/..//evil.com'],
    ['/./\\evil.com'],
    ['/%2e%2e//evil.com'],
    ['/%09/evil.com'],
    ['/\t/evil.com'],
    ['//evil.com'],
    ['/\\evil.com'],
    ['https://evil.com'],
    ['/acme/..//evil.com'],
    ['/acme/x/../..//evil.com'],
  ])('refreshDestination never returns an off-site target for %j', async (raw) => {
    const { refreshDestination } = await import('@/lib/session-refresh');

    const out = refreshDestination('acme', raw);

    expect(out.startsWith('//')).toBe(false);
    expect(out.startsWith('/\\')).toBe(false);
    expect(new URL(out, 'https://portal.test').origin).toBe('https://portal.test');
    expect(out === '/acme' || out.startsWith('/acme/') || out.startsWith('/acme?')).toBe(true);
  });

  it('keeps an in-app destination with its query and hash', async () => {
    const { refreshDestination } = await import('@/lib/session-refresh');

    expect(refreshDestination('acme', '/acme/x/../billing?tab=1#top')).toBe('/acme/billing?tab=1#top');
  });

  // Next decodes route params, so `/%2Fevil.com/session/refresh` arrives with
  // slug `/evil.com`. Before the slug check this answered `303 //evil.com/login`
  // with no cookie at all (measured against `next dev`).
  it.each([['/evil.com'], ['\\evil.com'], ['..'], ['.']])(
    'the refresh route refuses a slug that is not one plain segment (%j)',
    async (slug) => {
      const { GET } = await import('@/app/[slug]/session/refresh/route');

      const res = await GET(refreshRequest('/x', ''), { params: Promise.resolve({ slug }) });

      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    },
  );

  it('the render-time redirect never builds a protocol-relative refresh URL', async () => {
    const { refreshRouteFor } = await import('@/lib/session-refresh');

    expect(refreshRouteFor('/evil.com', '/x')).toBe('/');
  });
});
