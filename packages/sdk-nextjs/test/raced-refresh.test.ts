/**
 * `REFRESH_TOKEN_RACED`: the API rotated this refresh token moments ago for
 * another request (a second tab, a second instance) and revoked nothing.
 *
 * Every other `REFRESH_TOKEN_*` code means the token is finished and the
 * cookies go. This one does not: the browser already holds (or is about to
 * hold) the winning request's new pair, so clearing the cookies here would
 * delete that pair and sign the user out. What these pin:
 *
 *   - the refresh route goes back to `next` with the session cookies untouched,
 *     setting only the loop guard, which holds a digest and never the token;
 *   - `auth()` / `refreshSession()` in place rethrow it with the cookies kept;
 *   - the same token racing a second time is a verdict, so it cannot loop and
 *     the spent token is not kept around to be replayed as REUSED later;
 *   - the prefix rule still clears every other code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const jar = new Map<string, string>();
const cookieJar = {
  get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
  set: (n: string, v: string) => void jar.set(n, v),
  delete: (n: string) => void jar.delete(n),
};

class FakeRekeyError extends Error {
  constructor(
    public code: string,
    public statusCode?: number,
  ) {
    super(code);
  }
}

const refresh = vi.fn();
const getCurrentUser = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => new Headers({ host: 'app.example' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { refresh, getCurrentUser };
  },
  RekeyError: FakeRekeyError,
}));

const { auth, refreshSession, rekeyRefreshHandler, DEFAULT_REFRESH_PATH } = await import('../src/server.js');

let seq = 0;
/** A refresh token no other test used: the exchange grace is per process. */
let R1 = '';

const raced = () => new FakeRekeyError('REFRESH_TOKEN_RACED', 401);

beforeEach(() => {
  jar.clear();
  refresh.mockReset();
  getCurrentUser.mockReset();
  R1 = `r1_${++seq}_${Math.random().toString(36).slice(2)}`;
  process.env.REKEY_SECRET = 'rp_test_x';
  process.env.REKEY_URL = 'https://api.test.invalid';
});

function req(cookie: string): NextRequest {
  return new NextRequest(`https://app.example${DEFAULT_REFRESH_PATH}?next=%2Fdashboard`, { headers: { cookie } });
}

/** The Set-Cookie lines of a response, by cookie name. */
function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) out.set(line.split('=')[0]!, line);
  return out;
}

function markFrom(res: Response): string {
  return /^rekey_refresh_raced=([^;]+);/.exec(setCookies(res).get('rekey_refresh_raced') ?? '')?.[1] ?? '';
}

describe('the refresh route', () => {
  it('goes back to next with the session cookies untouched, setting only the loop guard', async () => {
    refresh.mockRejectedValue(raced());

    const res = await rekeyRefreshHandler()(req(`rekey_refresh=${R1}; rekey_access=old`));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard');
    const set = setCookies(res);
    expect(set.has('rekey_access')).toBe(false);
    expect(set.has('rekey_refresh')).toBe(false);
    expect(set.get('rekey_refresh_raced')).toMatch(/^rekey_refresh_raced=[0-9a-f]{32};/);
    expect(set.get('rekey_refresh_raced')).toMatch(/HttpOnly/i);
    expect(set.get('rekey_refresh_raced')).not.toContain(R1);
  });

  it('the same token racing a second time goes to sign-in and clears it, instead of looping', async () => {
    refresh.mockRejectedValue(raced());
    const handler = rekeyRefreshHandler({ signInUrl: '/login' });
    const first = await handler(req(`rekey_refresh=${R1}`));

    // The browser comes back still holding the spent token, and the mark.
    const second = await handler(req(`rekey_refresh=${R1}; rekey_refresh_raced=${markFrom(first)}`));

    expect(second.headers.get('location')).toBe('/login?next=%2Fdashboard');
    const set = setCookies(second);
    expect(set.get('rekey_refresh')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect(set.get('rekey_access')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('a mark left by a different token does not count as a repeat', async () => {
    refresh.mockRejectedValue(raced());
    const other = await rekeyRefreshHandler()(req(`rekey_refresh=${R1}-older`));

    const res = await rekeyRefreshHandler()(req(`rekey_refresh=${R1}; rekey_refresh_raced=${markFrom(other)}`));

    expect(res.headers.get('location')).toBe('/dashboard');
    expect(setCookies(res).has('rekey_refresh')).toBe(false);
  });

  it.each(['REFRESH_TOKEN_REUSED', 'REFRESH_TOKEN_RACE', 'REFRESH_TOKEN_RACED_X', 'REFRESH_TOKEN_SOMETHING_NEW'])(
    'every other REFRESH_TOKEN_* code (%s) still clears the session',
    async (code) => {
      refresh.mockRejectedValue(new FakeRekeyError(code, 401));

      const res = await rekeyRefreshHandler()(req(`rekey_refresh=${R1}`));

      expect(res.headers.get('location')).toBe('/sign-in?next=%2Fdashboard');
      expect(setCookies(res).get('rekey_refresh')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    },
  );
});

describe('in place: auth() and refreshSession()', () => {
  it('auth() rethrows RACED with the session cookies untouched', async () => {
    jar.set('rekey_refresh', R1);
    jar.set('rekey_access', 'dead');
    getCurrentUser.mockRejectedValue(new FakeRekeyError('USER_TOKEN_INVALID', 401));
    refresh.mockRejectedValue(raced());

    await expect(auth()).rejects.toMatchObject({ code: 'REFRESH_TOKEN_RACED' });

    expect(jar.get('rekey_refresh')).toBe(R1);
    expect(jar.get('rekey_access')).toBe('dead');
    expect(jar.get('rekey_refresh_raced')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refreshSession() racing twice on the same token clears it rather than failing forever', async () => {
    jar.set('rekey_refresh', R1);
    refresh.mockRejectedValue(raced());

    await expect(refreshSession()).rejects.toMatchObject({ code: 'REFRESH_TOKEN_RACED' });
    expect(jar.get('rekey_refresh')).toBe(R1);

    await expect(refreshSession()).resolves.toBeNull();
    expect(jar.has('rekey_refresh')).toBe(false);
  });
});
