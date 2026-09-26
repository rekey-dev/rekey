/**
 * A refresh must only happen where its result can be stored.
 *
 * The API rotates on every refresh and treats a replay of the rotated token as
 * theft, revoking every session the user has on every device. So a refresh
 * whose replacement cookies never reach the browser is not a harmless miss:
 * the browser keeps the spent token, and its next request signs the user out
 * everywhere.
 *
 * The earlier guard probed `cookies.delete()` for a throw once the response
 * had gone. Its test mocked `delete` to throw, and real Astro never does. So
 * these tests drive the REAL `AstroCookies` from the installed `astro`, and the
 * REAL `@rekey.dev/node` client against a fake API that counts calls, in both
 * states a jar can be in: before the response started, and after (the adapter
 * has consumed the headers, or `astro dev` has flagged the request as sent).
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- the fake API ---------------------------------------------------------

type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;

const calls = { refresh: 0, me: 0 };
let refreshHandler: Handler;
/** Access tokens the fake API accepts. Anything else is USER_TOKEN_INVALID. */
const liveAccess = new Set<string>();

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const fail = (status: number, code: string): Response =>
  new Response(JSON.stringify({ success: false, error: { code, message: code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const USER = { id: 'u1', email: 'a@b.c' };

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname.startsWith('/api/v1/users/me')) {
    calls.me += 1;
    const token = new Headers(init.headers).get('x-rekey-user-token') ?? '';
    return liveAccess.has(token) ? ok(USER) : fail(401, 'USER_TOKEN_INVALID');
  }
  if (url.pathname === '/api/v1/auth/refresh') {
    calls.refresh += 1;
    return refreshHandler(url, init);
  }
  return fail(404, 'NOT_FOUND');
}

// The client captures `fetch` when it is built, so the stub goes in first.
vi.stubGlobal('fetch', fakeFetch);

const rotateTo = (access: string, refresh: string): Handler => () => {
  liveAccess.add(access);
  return ok({ accessToken: access, refreshToken: refresh, user: USER });
};

// ---- the real AstroCookies ------------------------------------------------

// Not an export Astro publishes, so it is loaded by file from the installed
// package. The class is the one every Astro request hands to middleware and
// pages; that is the whole point of using it here.
const astroRoot = dirname(createRequire(import.meta.url).resolve('astro/package.json'));
// A plain path, not a file URL: Vite does not decode `%20`, and this repo's
// checkout path has a space in it.
const { AstroCookies } = (await import(join(astroRoot, 'dist/core/cookies/index.js'))) as {
  AstroCookies: new (request: Request) => {
    get(name: string): { value: string } | undefined;
    set(name: string, value: string, opts?: Record<string, unknown>): void;
    delete(name: string, opts?: Record<string, unknown>): void;
    headers(): Iterable<string>;
    consume(): Iterable<string>;
  };
};

const { getSession, setSession, clearSession, rekeyMiddleware } = await import('../src/index.js');

const cfg = { secretKey: 'rp_test_render', apiUrl: 'https://api.example.test' };

function request(cookie: string): Request {
  return new Request('https://app.example/dashboard', { headers: { cookie, host: 'app.example' } });
}

/** A signed-in browser whose access token has expired. */
function staleRequest(): Request {
  return request('rekey_access=a1; rekey_refresh=r1');
}

/** The Set-Cookie lines a jar would send, by cookie name. */
function outgoing(cookies: { headers(): Iterable<string> }): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of cookies.headers()) {
    const [pair] = line.split(';');
    const [name, value] = (pair ?? '').split('=');
    out.set(name ?? '', value ?? '');
  }
  return out;
}

/** What `astro dev` does to the request once the response has gone out. */
function markSentByDevServer(req: Request): void {
  Reflect.set(req, Symbol.for('astro.responseSent'), true);
}

const passThrough = async () => new Response('page');

beforeEach(() => {
  calls.refresh = 0;
  calls.me = 0;
  liveAccess.clear();
  refreshHandler = rotateTo('a2', 'r2');
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the premise: real Astro gives no signal once the response has gone', () => {
  it('neither delete() nor, in production, set() throws after the headers were taken', () => {
    const cookies = new AstroCookies(staleRequest());
    cookies.consume();

    // This is what the old probe relied on throwing. It does not.
    expect(() => cookies.delete('__rekey_probe', { path: '/' })).not.toThrow();
    // Production only warns, and the value goes nowhere: the adapter already
    // copied the headers.
    expect(() => cookies.set('rekey_refresh', 'r2')).not.toThrow();
  });
});

describe('a component rendered after the response started', () => {
  it('does not spend the refresh token (production: headers already consumed)', async () => {
    const cookies = new AstroCookies(staleRequest());
    cookies.consume();

    await expect(getSession(cookies, staleRequest(), cfg)).resolves.toBeNull();

    expect(calls.refresh).toBe(0);
    expect(outgoing(cookies).has('rekey_refresh')).toBe(false);
  });

  it('does not spend it under astro dev either, where set() would throw after the spend', async () => {
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    markSentByDevServer(req);

    await expect(getSession(cookies, req, cfg)).resolves.toBeNull();
    expect(calls.refresh).toBe(0);
  });

  it('refuses even an explicit refresh once astro dev has flagged the response as sent', async () => {
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    markSentByDevServer(req);

    await expect(getSession(cookies, req, cfg, { refresh: true })).resolves.toBeNull();
    expect(calls.refresh).toBe(0);
  });

  it('says why, once, instead of signing people out in silence', async () => {
    // A fresh copy of the module, so the once-per-process flag starts unset.
    vi.resetModules();
    const fresh = await import('../src/index.js');
    await fresh.getSession(new AstroCookies(staleRequest()), staleRequest(), cfg);
    await fresh.getSession(new AstroCookies(staleRequest()), staleRequest(), cfg);

    // Once per process, not once per call: a page can call this many times.
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toMatch(/rekeyMiddleware/);
  });

  it('still reads a live access token without any refresh', async () => {
    liveAccess.add('a1');
    const cookies = new AstroCookies(staleRequest());
    cookies.consume();

    await expect(getSession(cookies, staleRequest(), cfg)).resolves.toEqual({
      user: USER,
      accessToken: 'a1',
    });
    expect(calls.refresh).toBe(0);
  });
});

describe('the middleware is where a request refreshes', () => {
  it('rotates before next() and writes both cookies into the response', async () => {
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};

    await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);

    expect(calls.refresh).toBe(1);
    expect(locals.session).toEqual({ user: USER, accessToken: 'a2' });
    const out = outgoing(cookies);
    expect(out.get('rekey_access')).toBe('a2');
    expect(out.get('rekey_refresh')).toBe('r2');
  });

  it('hands a later component its result, with no second rotation and no API call', async () => {
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};
    await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);
    const meCalls = calls.me;
    cookies.consume();

    await expect(getSession(cookies, req, cfg, { refresh: true })).resolves.toBe(locals.session);
    expect(calls.refresh).toBe(1);
    expect(calls.me).toBe(meCalls);
  });

  it('never lets a later call rotate, even when the middleware came up empty', async () => {
    // The middleware's refresh failed in a way that kept the cookie. A
    // component later in the same request must not try again: it would be
    // rotating after the response started.
    refreshHandler = () => fail(429, 'RATE_LIMITED');
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};
    await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);
    expect(locals.session).toBeNull();

    refreshHandler = rotateTo('a2', 'r2');
    await expect(getSession(cookies, req, cfg, { refresh: true })).resolves.toBeNull();
    expect(calls.refresh).toBe(1);
  });

  it('reports signed out after sign-out in the same request, and has nothing to rotate', async () => {
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};
    await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);
    expect(locals.session).not.toBeNull();

    clearSession(cookies);

    await expect(getSession(cookies, req, cfg, { refresh: true })).resolves.toBeNull();
    expect(calls.refresh).toBe(1);
  });

  it('reads the new cookies after an endpoint signs in during the same request', async () => {
    const req = request('');
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};
    await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);
    expect(locals.session).toBeNull();

    liveAccess.add('a9');
    setSession(cookies, req, { accessToken: 'a9', refreshToken: 'r9' }, cfg);

    await expect(getSession(cookies, req, cfg)).resolves.toEqual({ user: USER, accessToken: 'a9' });
  });
});

describe('an endpoint can opt in, before its response exists', () => {
  it('rotates and writes both cookies with { refresh: true }', async () => {
    const req = staleRequest();
    const cookies = new AstroCookies(req);

    await expect(getSession(cookies, req, cfg, { refresh: true })).resolves.toEqual({
      user: USER,
      accessToken: 'a2',
    });
    expect(calls.refresh).toBe(1);
    expect(outgoing(cookies).get('rekey_refresh')).toBe('r2');
  });

  it('does not rotate without it', async () => {
    const req = staleRequest();
    await expect(getSession(new AstroCookies(req), req, cfg)).resolves.toBeNull();
    expect(calls.refresh).toBe(0);
  });
});

/**
 * The same rules as `@rekey.dev/nextjs`. The API rotates FIRST and then does
 * the fallible rest, so a 5xx or a dropped connection may arrive after the
 * token was spent; keeping it then turns the next request into a replay.
 * Only a failure that provably came before the rotation keeps the cookie.
 */
describe('what a failed refresh does to the cookies', () => {
  const netError = (code: string) => () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
  };

  const cleared = [
    ['REFRESH_TOKEN_REUSED (a verdict)', () => fail(401, 'REFRESH_TOKEN_REUSED'), 'null'],
    ['a verdict code added after this was written', () => fail(401, 'REFRESH_TOKEN_SOMETHING_NEW'), 'null'],
    ['a 5xx (the API may have rotated first)', () => fail(503, 'SERVICE_UNAVAILABLE'), 'throws'],
    ['a connection reset mid-request', netError('ECONNRESET'), 'throws'],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      'throws',
    ],
  ] as const;

  it.each(cleared)('clears both cookies on %s', async (_label, handler, outcome) => {
    refreshHandler = handler as Handler;
    const req = staleRequest();
    const cookies = new AstroCookies(req);

    const result = getSession(cookies, req, cfg, { refresh: true });
    if (outcome === 'null') await expect(result).resolves.toBeNull();
    else await expect(result).rejects.toMatchObject({ name: 'RekeyError' });

    const out = outgoing(cookies);
    expect(out.get('rekey_refresh')).toBe('deleted');
    expect(out.get('rekey_access')).toBe('deleted');
  });

  const kept = [
    ['a 429 (refused before rotating)', () => fail(429, 'RATE_LIMITED')],
    ['another non-verdict 4xx', () => fail(400, 'VALIDATION_ERROR')],
    ['a refused connection (nothing was sent)', netError('ECONNREFUSED')],
    ['a DNS failure (nothing was sent)', netError('ENOTFOUND')],
    [
      'a refused localhost over both address families',
      () => {
        const refused = (address: string) =>
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', address });
        throw new TypeError('fetch failed', {
          cause: new AggregateError([refused('::1'), refused('127.0.0.1')]),
        });
      },
    ],
  ] as const;

  it.each(kept)('keeps the cookies and throws on %s', async (_label, handler) => {
    refreshHandler = handler as Handler;
    const req = staleRequest();
    const cookies = new AstroCookies(req);

    await expect(getSession(cookies, req, cfg, { refresh: true })).rejects.toMatchObject({
      name: 'RekeyError',
    });
    expect(outgoing(cookies).has('rekey_refresh')).toBe(false);
    expect(outgoing(cookies).has('rekey_access')).toBe(false);
  });

  it('clears on a 5xx through the middleware too, and still renders signed out', async () => {
    refreshHandler = () => fail(502, 'BAD_GATEWAY');
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};

    const res = await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);

    expect(await res.text()).toBe('page');
    expect(locals.session).toBeNull();
    expect(outgoing(cookies).get('rekey_refresh')).toBe('deleted');
  });
});

/**
 * `REFRESH_TOKEN_RACED`: another request (a second tab) rotated this token
 * moments ago and the API revoked nothing. The browser already holds, or is
 * about to hold, that request's new pair, so clearing the cookies here would
 * delete it and sign the user out. Every other REFRESH_TOKEN_* code still
 * clears (above).
 */
describe('a raced refresh (REFRESH_TOKEN_RACED)', () => {
  const racedHandler: Handler = () => fail(401, 'REFRESH_TOKEN_RACED');

  it('middleware: a page load goes back to its own URL with the session cookies untouched', async () => {
    refreshHandler = racedHandler;
    const req = new Request('https://app.example/dashboard?tab=2', {
      headers: { cookie: 'rekey_access=a1; rekey_refresh=r1', host: 'app.example' },
    });
    const cookies = new AstroCookies(req);
    const next = vi.fn(passThrough);

    const res = await rekeyMiddleware(cfg)({ cookies, request: req, locals: {} }, next);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard?tab=2');
    expect(next).not.toHaveBeenCalled();
    const out = outgoing(cookies);
    expect(out.has('rekey_access')).toBe(false);
    expect(out.has('rekey_refresh')).toBe(false);
    expect(out.get('rekey_refresh_raced')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('middleware: never echoes a protocol-relative path back as the redirect', async () => {
    refreshHandler = racedHandler;
    const req = new Request('https://app.example//evil.example/x', {
      headers: { cookie: 'rekey_access=a1; rekey_refresh=r1', host: 'app.example' },
    });

    const res = await rekeyMiddleware(cfg)({ cookies: new AstroCookies(req), request: req, locals: {} }, passThrough);

    expect(new URL(res.headers.get('location') ?? '', 'https://app.example').origin).toBe('https://app.example');
  });

  it('middleware: a POST renders signed out for this request, cookies kept', async () => {
    refreshHandler = racedHandler;
    const req = new Request('https://app.example/settings', {
      method: 'POST',
      headers: { cookie: 'rekey_access=a1; rekey_refresh=r1', host: 'app.example' },
    });
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};

    const res = await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);

    expect(await res.text()).toBe('page');
    expect(locals.session).toBeNull();
    expect(outgoing(cookies).has('rekey_refresh')).toBe(false);
  });

  it('middleware: the same token racing again clears it and renders, instead of looping', async () => {
    refreshHandler = racedHandler;
    const first = staleRequest();
    const firstCookies = new AstroCookies(first);
    await rekeyMiddleware(cfg)({ cookies: firstCookies, request: first, locals: {} }, passThrough);
    const mark = outgoing(firstCookies).get('rekey_refresh_raced');

    // The browser comes back still holding the spent token, and the mark.
    const again = request(`rekey_access=a1; rekey_refresh=r1; rekey_refresh_raced=${mark}`);
    const cookies = new AstroCookies(again);
    const locals: Record<string, unknown> = {};
    const res = await rekeyMiddleware(cfg)({ cookies, request: again, locals }, passThrough);

    expect(await res.text()).toBe('page');
    expect(locals.session).toBeNull();
    expect(outgoing(cookies).get('rekey_refresh')).toBe('deleted');
  });

  it('a mark left by a different token does not count as a repeat', async () => {
    refreshHandler = racedHandler;
    const other = request('rekey_access=a1; rekey_refresh=r0');
    const otherCookies = new AstroCookies(other);
    await rekeyMiddleware(cfg)({ cookies: otherCookies, request: other, locals: {} }, passThrough);
    const otherMark = outgoing(otherCookies).get('rekey_refresh_raced');

    const req = request(`rekey_access=a1; rekey_refresh=r1; rekey_refresh_raced=${otherMark}`);
    const res = await rekeyMiddleware(cfg)({ cookies: new AstroCookies(req), request: req, locals: {} }, passThrough);

    expect(res.status).toBe(303);
  });

  it('getSession({ refresh: true }): throws RACED with the session cookies kept', async () => {
    refreshHandler = racedHandler;
    const req = staleRequest();
    const cookies = new AstroCookies(req);

    await expect(getSession(cookies, req, cfg, { refresh: true })).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_RACED',
    });
    const out = outgoing(cookies);
    expect(out.has('rekey_refresh')).toBe(false);
    expect(out.has('rekey_access')).toBe(false);
  });
});

/**
 * Every API redeploy puts a proxy's 502/503/504 in front of the refresh, with
 * no Rekey error body. That request never reached the API, so the token is
 * unspent, and signing the visitor out for it signed out every stale visitor
 * on every deploy.
 */
describe('a proxy answering while the API restarts', () => {
  const bare =
    (status: number): Handler =>
    () =>
      new Response('<html>Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } });

  it.each([502, 503, 504])('%i with no Rekey envelope keeps both cookies', async (status) => {
    refreshHandler = bare(status);
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};

    const res = await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);

    expect(await res.text()).toBe('page');
    expect(locals.session).toBeNull();
    expect(outgoing(cookies).has('rekey_refresh')).toBe(false);
    expect(outgoing(cookies).has('rekey_access')).toBe(false);
  });

  it('a 503 the API answered itself still clears them', async () => {
    refreshHandler = () => fail(503, 'SERVICE_UNAVAILABLE');
    const req = staleRequest();
    const cookies = new AstroCookies(req);
    await rekeyMiddleware(cfg)({ cookies, request: req, locals: {} }, passThrough);
    expect(outgoing(cookies).get('rekey_refresh')).toBe('deleted');
  });
});

/**
 * A cross-site navigation carries the Lax refresh cookie. Rotating for it
 * would let the page that started it abort the navigation and drop the new
 * pair, leaving the browser a spent token to replay.
 */
describe('only this origin may start a rotation', () => {
  function crossSite(extra: Record<string, string> = {}, method = 'GET'): Request {
    return new Request('https://app.example/dashboard?tab=2', {
      method,
      headers: {
        cookie: 'rekey_access=a1; rekey_refresh=r1',
        host: 'app.example',
        'sec-fetch-site': 'cross-site',
        ...extra,
      },
    });
  }

  it('a cross-site page load gets the interstitial: no API call, no cookie', async () => {
    const req = crossSite({ 'sec-fetch-dest': 'document' });
    const cookies = new AstroCookies(req);
    const next = vi.fn(passThrough);

    const res = await rekeyMiddleware(cfg)({ cookies, request: req, locals: {} }, next);

    expect(calls.refresh).toBe(0);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('content="0;url=/dashboard?tab=2"');
    expect(html).not.toContain('<script');
    expect([...cookies.headers()]).toEqual([]);
  });

  it('a cross-site POST renders signed out for this request, cookies kept', async () => {
    const req = crossSite({}, 'POST');
    const cookies = new AstroCookies(req);
    const locals: Record<string, unknown> = {};
    const res = await rekeyMiddleware(cfg)({ cookies, request: req, locals }, passThrough);
    expect(calls.refresh).toBe(0);
    expect(await res.text()).toBe('page');
    expect(locals.session).toBeNull();
    expect([...cookies.headers()]).toEqual([]);
  });

  it('getSession({ refresh: true }) on a cross-site request does not rotate', async () => {
    const req = crossSite();
    const cookies = new AstroCookies(req);
    expect(await getSession(cookies, req, cfg, { refresh: true })).toBeNull();
    expect(calls.refresh).toBe(0);
  });

  it.each(['same-origin', 'none'])('%s rotates', async (site) => {
    const req = new Request('https://app.example/dashboard', {
      headers: { cookie: 'rekey_access=a1; rekey_refresh=r1', host: 'app.example', 'sec-fetch-site': site },
    });
    const cookies = new AstroCookies(req);
    await rekeyMiddleware(cfg)({ cookies, request: req, locals: {} }, passThrough);
    expect(calls.refresh).toBe(1);
    expect(outgoing(cookies).get('rekey_refresh')).toBe('r2');
  });
});
