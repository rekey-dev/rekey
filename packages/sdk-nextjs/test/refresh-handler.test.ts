/**
 * `rekeyRefreshHandler()`, the route `rekeyMiddleware` sends a stale session to.
 *
 * What it must never do: send the browser off-origin or back to itself, delete
 * a refresh cookie over a blip, or let a second request present a token this
 * process has just spent. The API answers that last one by revoking every
 * session the user has.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

class FakeRekeyError extends Error {
  constructor(
    public code: string,
    public statusCode?: number,
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

const refresh = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => {
    throw new Error('the handler must not depend on next/headers');
  },
  headers: async () => new Headers(),
}));
vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { refresh };
  },
  RekeyError: FakeRekeyError,
}));

const { rekeyRefreshHandler, DEFAULT_REFRESH_PATH } = await import('../src/server.js');
const { rekeyMiddleware } = await import('../src/middleware.js');
const { safeReturnPath } = await import('../src/paths.js');

let tokenSeq = 0;
/** A refresh token no other test has used, since the grace map is per process. */
const freshToken = () => `r_${++tokenSeq}_${Math.random().toString(36).slice(2)}`;

function req(query: string, cookie?: string): NextRequest {
  return new NextRequest(`https://app.example${DEFAULT_REFRESH_PATH}${query}`, {
    headers: cookie ? { cookie } : {},
  });
}

/** The Set-Cookie lines of a response, by cookie name. */
function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) out.set(line.split('=')[0]!, line);
  return out;
}

beforeEach(() => {
  refresh.mockReset();
  process.env.REKEY_SECRET = 'rp_test_x';
  process.env.REKEY_URL = 'https://api.test.invalid';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a successful rotation', () => {
  it('writes both cookies and sends the browser to `next`', async () => {
    const token = freshToken();
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });

    const res = await rekeyRefreshHandler()(req('?next=%2Fdashboard%3Ftab%3D2', `rekey_refresh=${token}`));

    expect(refresh).toHaveBeenCalledWith(token);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard?tab=2');
    const set = setCookies(res);
    expect(set.get('rekey_access')).toMatch(/^rekey_access=a2;/);
    expect(set.get('rekey_refresh')).toMatch(/^rekey_refresh=r2;/);
    expect(set.get('rekey_refresh')).toMatch(/HttpOnly/i);
    expect(set.get('rekey_refresh')).toMatch(/Secure/i);
    expect(set.get('rekey_access')).toMatch(/Max-Age=900/);
  });

  it('lands where the middleware asked it to', async () => {
    // The two halves agree on the path and the parameter, end to end.
    const token = freshToken();
    const page = new NextRequest('https://app.example/reports?range=7d', {
      headers: { cookie: `rekey_refresh=${token}` },
    });
    const hop = rekeyMiddleware()(page);
    const refreshUrl = new URL(hop.headers.get('location')!);
    expect(refreshUrl.pathname).toBe(DEFAULT_REFRESH_PATH);

    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const res = await rekeyRefreshHandler()(
      new NextRequest(refreshUrl, { headers: { cookie: `rekey_refresh=${token}` } }),
    );
    expect(res.headers.get('location')).toBe('/reports?range=7d');
  });
});

describe('`next` never leaves the origin or points back here', () => {
  it.each([
    ['protocol-relative', '//evil.com/x'],
    ['backslash', '/\\evil.com'],
    ['backslash later on', '/a\\b'],
    ['tab', '/\t/evil.com'],
    ['newline', '/\n/evil.com'],
    ['absolute URL', 'https://evil.com/'],
    ['javascript:', 'javascript:alert(1)'],
    ['no leading slash', 'dashboard'],
    ['the refresh route', DEFAULT_REFRESH_PATH],
    ['the refresh route with a query', `${DEFAULT_REFRESH_PATH}?next=/x`],
    ['beneath the refresh route', `${DEFAULT_REFRESH_PATH}/`],
    ['the refresh route via dot segments', '/api/rekey/./refresh'],
    ['empty', ''],
    // Dot segments collapse while parsing, so these pass every input check and
    // come out of the URL parser as `//evil.com`, protocol-relative.
    ['dot-dot then a double slash', '/..//evil.com'],
    ['a segment, dot-dot, double slash', '/x/..//evil.com'],
    ['encoded dot-dot then a double slash', '/%2e%2e//evil.com'],
    ['mixed-case encoded dot-dot', '/%2E%2e//evil.com'],
    ['dot then a double slash', '/.//evil.com'],
    ['climbing past the root', '/a/../../..//evil.com'],
    ['an encoded tab', '/%09/evil.com'],
    ['an encoded slash', '/..%2f/evil.com'],
    ['an encoded backslash', '/%5cevil.com'],
  ])('%s is refused', async (_label, next) => {
    // A distinct fallback, so "refused" cannot pass as "cleaned up into /".
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const res = await rekeyRefreshHandler({ fallbackUrl: '/fallback' })(
      req(`?next=${encodeURIComponent(next)}`, `rekey_refresh=${freshToken()}`),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/fallback');
  });

  it('falls back to / by default', async () => {
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const res = await rekeyRefreshHandler()(
      req('?next=%2F%2Fevil.com', `rekey_refresh=${freshToken()}`),
    );
    expect(res.headers.get('location')).toBe('/');
  });

  it('refuses its own path when mounted somewhere else', async () => {
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const res = await rekeyRefreshHandler()(
      new NextRequest('https://app.example/auth/renew?next=%2Fauth%2Frenew', {
        headers: { cookie: `rekey_refresh=${freshToken()}` },
      }),
    );
    expect(res.headers.get('location')).toBe('/');
  });

  it('returns the parsed path, not the caller string', async () => {
    // A raw non-Latin-1 character is not a legal header value; the rebuilt
    // path is percent-encoded.
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const res = await rekeyRefreshHandler()(
      req(`?next=${encodeURIComponent('/日本?q=1#top')}`, `rekey_refresh=${freshToken()}`),
    );
    expect(res.headers.get('location')).toBe('/%E6%97%A5%E6%9C%AC?q=1#top');
  });

  it('uses fallbackUrl when configured', async () => {
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const res = await rekeyRefreshHandler({ fallbackUrl: '/home' })(
      req('?next=%2F%2Fevil.com', `rekey_refresh=${freshToken()}`),
    );
    expect(res.headers.get('location')).toBe('/home');
  });
});

describe('safeReturnPath on its own', () => {
  it.each([
    '/..//evil.com',
    '/x/..//evil.com',
    '/%2e%2e//evil.com',
    '/.//evil.com',
    '/%09/evil.com',
    '/..%2f/evil.com',
    '/./%2fevil.com',
  ])('%s is null', (raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it.each([
    ['/dashboard?tab=2#top', '/dashboard?tab=2#top'],
    ['/a/../b', '/b'],
    ['/search?q=a%2Fb', '/search?q=a%2Fb'],
    ['/?next=//evil.com', '/?next=//evil.com'],
  ])('%s is kept as %s', (raw, out) => {
    expect(safeReturnPath(raw)).toBe(out);
  });
});

describe('the middleware redirects are never cached', () => {
  // Both depend on the visitor's cookies, not the URL. A shared cache holding
  // one would send every later visitor to the refresh route or sign-in.
  it('the hop to the refresh route', () => {
    const res = rekeyMiddleware()(
      new NextRequest('https://app.example/reports?range=7d', { headers: { cookie: 'rekey_refresh=r' } }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the bounce to sign-in, keeping the query in `next`', () => {
    const res = rekeyMiddleware()(new NextRequest('https://app.example/reports?range=7d'));
    expect(res.status).toBe(307);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('next')).toBe('/reports?range=7d');
    expect([...loc.searchParams.keys()]).toEqual(['next']);
  });
});

describe('a finished token', () => {
  it.each(['REFRESH_TOKEN_EXPIRED', 'REFRESH_TOKEN_REVOKED', 'REFRESH_TOKEN_SOMETHING_NEW'])(
    '%s clears both cookies and goes to sign-in',
    async (code) => {
      refresh.mockRejectedValue(new FakeRekeyError(code, 401));
      const res = await rekeyRefreshHandler({ signInUrl: '/login' })(
        req('?next=%2Fdashboard', `rekey_refresh=${freshToken()}; rekey_access=old`),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard');
      const set = setCookies(res);
      expect(set.get('rekey_access')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      expect(set.get('rekey_refresh')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    },
  );

  it('with no refresh cookie at all, goes to sign-in touching nothing', async () => {
    const res = await rekeyRefreshHandler()(req('?next=%2Fdashboard'));
    expect(refresh).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fdashboard');
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('a failed request is not a verdict', () => {
  it('429 keeps the cookies and answers 503 with Retry-After', async () => {
    refresh.mockRejectedValue(new FakeRekeyError('RATE_LIMITED', 429, 7));
    const res = await rekeyRefreshHandler()(req('?next=%2Fdashboard', `rekey_refresh=${freshToken()}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('a connection that was never made keeps the cookies too', async () => {
    // Refused at connect, so the request never reached the API. A network
    // error that cannot prove that clears them (in-place-refresh.test.ts).
    refresh.mockRejectedValue(
      Object.assign(new FakeRekeyError('NETWORK_ERROR'), {
        cause: Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      }),
    );
    const res = await rekeyRefreshHandler()(req('?next=%2Fdashboard', `rekey_refresh=${freshToken()}`));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('a failed exchange is not remembered, so the next request tries again', async () => {
    const token = freshToken();
    refresh.mockRejectedValueOnce(new FakeRekeyError('RATE_LIMITED', 429));
    refresh.mockResolvedValueOnce({ accessToken: 'a2', refreshToken: 'r2' });
    const handler = rekeyRefreshHandler();
    expect((await handler(req('', `rekey_refresh=${token}`))).status).toBe(503);
    expect((await handler(req('', `rekey_refresh=${token}`))).status).toBe(303);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('a spent token is never presented twice by this process', () => {
  it('concurrent requests share one exchange', async () => {
    const token = freshToken();
    let release!: (v: { accessToken: string; refreshToken: string }) => void;
    refresh.mockReturnValue(new Promise((r) => (release = r)));
    const handler = rekeyRefreshHandler();

    const pending = [1, 2, 3].map(() => handler(req('?next=%2Fa', `rekey_refresh=${token}`)));
    // Released only once all three are waiting on it: sharing is for requests
    // that overlap, and nothing is kept once the exchange settles.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    release({ accessToken: 'a2', refreshToken: 'r2' });
    const responses = await Promise.all(pending);

    expect(refresh).toHaveBeenCalledTimes(1);
    for (const res of responses) {
      expect(setCookies(res).get('rekey_refresh')).toMatch(/^rekey_refresh=r2;/);
    }
  });

  it('a late request is never handed the new pair: it goes to the API and gets the RACED handling', async () => {
    // The API is the only judge of a spent token. A fake API that rotates once
    // and answers RACED for the spent token after that, as the real one does.
    const token = freshToken();
    refresh
      .mockResolvedValueOnce({ accessToken: 'a2', refreshToken: 'r2' })
      .mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_RACED', 401));
    const handler = rekeyRefreshHandler();

    await handler(req('?next=%2Fa', `rekey_refresh=${token}`));
    // Well inside the ten seconds the old grace would have covered.
    const late = await handler(req('?next=%2Fa', `rekey_refresh=${token}`));

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(late.status).toBe(303);
    expect(late.headers.get('location')).toBe('/a');
    const set = setCookies(late);
    expect(set.has('rekey_access')).toBe(false);
    expect(set.has('rekey_refresh')).toBe(false);
    expect(set.get('rekey_refresh_raced')).toMatch(/^rekey_refresh_raced=[0-9a-f]{32};/);
  });

  it('concurrent requests naming different devices are each asked about with their own', async () => {
    const token = freshToken();
    let release!: (v: { accessToken: string; refreshToken: string }) => void;
    refresh.mockReturnValueOnce(new Promise((r) => (release = r)));
    refresh.mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_DEVICE_MISMATCH', 401));
    const device = { fingerprint: 'fp-other-machine' };

    const first = rekeyRefreshHandler()(req('', `rekey_refresh=${token}`));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const second = rekeyRefreshHandler({ device: () => device })(req('', `rekey_refresh=${token}`));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    release({ accessToken: 'a2', refreshToken: 'r2' });

    expect(refresh).toHaveBeenLastCalledWith(token, { device });
    // The second never receives the first's pair.
    expect(setCookies(await second).get('rekey_refresh') ?? '').not.toMatch(/^rekey_refresh=r2;/);
    expect(setCookies(await first).get('rekey_refresh')).toMatch(/^rekey_refresh=r2;/);
  });

  it('a late request naming a device is asked about with that device', async () => {
    const token = freshToken();
    const device = { fingerprint: 'fp-other-machine' };
    refresh
      .mockResolvedValueOnce({ accessToken: 'a2', refreshToken: 'r2' })
      .mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_DEVICE_MISMATCH', 401));
    await rekeyRefreshHandler()(req('', `rekey_refresh=${token}`));
    const late = await rekeyRefreshHandler({ device: () => device })(req('', `rekey_refresh=${token}`));

    expect(refresh).toHaveBeenLastCalledWith(token, { device });
    expect(late.headers.get('location')).toMatch(/^\/sign-in\?next=/);
  });

  it('a different token is a different exchange', async () => {
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const handler = rekeyRefreshHandler();
    await handler(req('', `rekey_refresh=${freshToken()}`));
    await handler(req('', `rekey_refresh=${freshToken()}`));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops answering a token that keeps coming back, instead of looping', async () => {
    // A browser that drops every cookie it is sent: the spent token and no
    // loop guard, lap after lap. Each lap is a RACED from the API until the
    // handler recognises the pattern.
    const token = freshToken();
    refresh
      .mockResolvedValueOnce({ accessToken: 'a2', refreshToken: 'r2' })
      .mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_RACED', 401));
    const handler = rekeyRefreshHandler();

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await handler(req('?next=%2Fa', `rekey_refresh=${token}`))).status);
    }

    expect(refresh).toHaveBeenCalledTimes(11);
    expect(statuses.slice(0, 11)).toEqual(Array(11).fill(303));
    expect(statuses[11]).toBe(500);
  });
});

describe('a proxy answering for an API that is not there', () => {
  it.each([502, 503, 504])('%i with no Rekey envelope keeps the cookies and answers 503', async (status) => {
    refresh.mockRejectedValue(new FakeRekeyError('UNKNOWN_ERROR', status));
    const res = await rekeyRefreshHandler()(req('?next=%2Fdashboard', `rekey_refresh=${freshToken()}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('a 503 the API itself answered clears both cookies and says the session was interrupted', async () => {
    refresh.mockRejectedValue(new FakeRekeyError('SERVICE_UNAVAILABLE', 503));
    const res = await rekeyRefreshHandler()(req('?next=%2Fdashboard', `rekey_refresh=${freshToken()}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fdashboard&reason=session_interrupted');
    const set = setCookies(res);
    expect(set.get('rekey_access')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect(set.get('rekey_refresh')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('a finished token is not called interrupted', async () => {
    refresh.mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_EXPIRED', 401));
    const res = await rekeyRefreshHandler()(req('?next=%2Fdashboard', `rekey_refresh=${freshToken()}`));
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fdashboard');
  });
});

describe('only this origin may start a rotation', () => {
  function fromSite(site: string | null, token: string): NextRequest {
    const headers: Record<string, string> = { cookie: `rekey_refresh=${token}` };
    if (site) headers['sec-fetch-site'] = site;
    return new NextRequest(`https://app.example${DEFAULT_REFRESH_PATH}?next=%2Fdashboard`, { headers });
  }

  it.each(['cross-site', 'same-site'])('%s gets the interstitial, no API call and no cookie', async (site) => {
    const res = await rekeyRefreshHandler()(fromSite(site, freshToken()));
    expect(refresh).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain(`content="0;url=${DEFAULT_REFRESH_PATH}?next=%2Fdashboard"`);
    expect(html).toContain(`href="${DEFAULT_REFRESH_PATH}?next=%2Fdashboard"`);
    expect(html).not.toContain('<script');
  });

  it.each(['same-origin', 'none', null])('%s rotates', async (site) => {
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    const res = await rekeyRefreshHandler()(fromSite(site, freshToken()));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(setCookies(res).get('rekey_refresh')).toMatch(/^rekey_refresh=r2;/);
  });
});
