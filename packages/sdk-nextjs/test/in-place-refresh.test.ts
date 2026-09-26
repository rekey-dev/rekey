/**
 * `auth()` and `refreshSession()` rotating in place, in a Server Action or a
 * route handler.
 *
 * Three properties the refresh route already had and these two did not:
 *
 *   - they share its per-process exchange, so an action and a concurrent page
 *     load presenting the same cookie cannot both spend it (the API reads the
 *     second as theft and revokes every session the user has);
 *   - a failure that may have come after the API rotated (5xx, timeout, a
 *     connection lost mid-request) clears the cookies instead of leaving a
 *     possibly spent token to be replayed;
 *   - the access cookie lives exactly as long as the token in it.
 *
 * And one read per access token per request: a layout and a page that both
 * call `auth()` cost one `/users/me`, not two.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const jar = new Map<string, { value: string; opts?: { maxAge?: number } | undefined }>();
const cookieJar = {
  get: (n: string) => (jar.has(n) ? { value: jar.get(n)!.value } : undefined),
  set: (n: string, value: string, opts?: { maxAge?: number }) => void jar.set(n, { value, opts }),
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
const signInRemote = vi.fn();

/**
 * React's `cache()` only memoizes inside a React server request, which a
 * unit test does not have. This stands in for one request: memoized by
 * arguments until `newRequest()` clears it.
 */
const requestScopes: Array<Map<string, unknown>> = [];
function newRequest() {
  for (const scope of requestScopes) scope.clear();
}
vi.mock('react', () => ({
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const scope = new Map<string, unknown>();
    requestScopes.push(scope);
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!scope.has(key)) scope.set(key, fn(...args));
      return scope.get(key) as R;
    };
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => new Headers({ host: 'app.example' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { refresh, getCurrentUser, signIn: signInRemote };
  },
  RekeyError: FakeRekeyError,
}));

const { auth, refreshSession, rekeyRefreshHandler, signIn, DEFAULT_REFRESH_PATH } = await import(
  '../src/server.js'
);

let seq = 0;
/** A refresh token no other test used: the exchange grace is per process. */
let R1 = '';

const USER = { id: 'u1', email: 'a@b.c' };

beforeEach(() => {
  jar.clear();
  newRequest();
  refresh.mockReset();
  getCurrentUser.mockReset();
  signInRemote.mockReset();
  getCurrentUser.mockResolvedValue(USER);
  R1 = `r1_${++seq}_${Math.random().toString(36).slice(2)}`;
  process.env.REKEY_SECRET = 'rp_test_x';
  process.env.REKEY_URL = 'https://api.test.invalid';
});

/** A `NETWORK_ERROR` shaped like the one `@rekey.dev/node` builds from undici. */
function networkError(socketError: object): FakeRekeyError {
  return Object.assign(new FakeRekeyError('NETWORK_ERROR'), {
    cause: Object.assign(new TypeError('fetch failed'), { cause: socketError }),
  });
}
const sysErr = (code: string) => Object.assign(new Error(code), { code });

/** An unsigned JWT with the given claims; the SDK only reads `iat`/`exp`. */
function jwt(claims: Record<string, number>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

describe('a failure that may have come after the rotation clears the cookies', () => {
  it.each([
    ['a timeout', () => new FakeRekeyError('REQUEST_TIMEOUT')],
    ['a 503', () => new FakeRekeyError('SERVICE_UNAVAILABLE', 503)],
    ['a 500 with no envelope', () => new FakeRekeyError('UNKNOWN_ERROR', 500)],
    ['a network error with no cause', () => new FakeRekeyError('NETWORK_ERROR')],
    ['a connection reset mid-request', () => networkError(sysErr('ECONNRESET'))],
    ['a socket closed mid-request', () => networkError(sysErr('UND_ERR_SOCKET'))],
  ])('%s: auth() clears both and still throws', async (_label, make) => {
    jar.set('rekey_access', { value: 'a1' });
    jar.set('rekey_refresh', { value: R1 });
    getCurrentUser.mockRejectedValueOnce(new FakeRekeyError('USER_TOKEN_INVALID'));
    refresh.mockRejectedValue(make());

    // Still an error, not a signed-out user: the API had a bad moment.
    await expect(auth()).rejects.toBeInstanceOf(FakeRekeyError);
    expect(jar.has('rekey_refresh')).toBe(false);
    expect(jar.has('rekey_access')).toBe(false);
  });

  it('refreshSession() does the same', async () => {
    jar.set('rekey_refresh', { value: R1 });
    refresh.mockRejectedValue(new FakeRekeyError('REQUEST_TIMEOUT'));
    await expect(refreshSession()).rejects.toBeInstanceOf(FakeRekeyError);
    expect(jar.has('rekey_refresh')).toBe(false);
  });
});

describe('a failure that cannot have rotated keeps them', () => {
  it.each([
    ['a 429', () => new FakeRekeyError('RATE_LIMITED', 429)],
    ['a 400 refusal', () => new FakeRekeyError('VALIDATION_ERROR', 400)],
    ['a device refused before rotating', () => new FakeRekeyError('DEVICE_BLOCKED', 403)],
    ['connection refused', () => networkError(sysErr('ECONNREFUSED'))],
    [
      'connection refused on both address families',
      () =>
        networkError(
          Object.assign(new AggregateError([sysErr('ECONNREFUSED'), sysErr('ECONNREFUSED')]), {
            code: 'ECONNREFUSED',
          }),
        ),
    ],
    ['DNS failure', () => networkError(sysErr('ENOTFOUND'))],
    ['DNS timeout', () => networkError(sysErr('EAI_AGAIN'))],
    ['connect timeout', () => networkError(sysErr('UND_ERR_CONNECT_TIMEOUT'))],
  ])('%s', async (_label, make) => {
    jar.set('rekey_refresh', { value: R1 });
    refresh.mockRejectedValue(make());
    await expect(refreshSession()).rejects.toBeInstanceOf(FakeRekeyError);
    expect(jar.get('rekey_refresh')?.value).toBe(R1);
  });

  it('an AggregateError with one address reset mid-request counts as sent', async () => {
    jar.set('rekey_refresh', { value: R1 });
    refresh.mockRejectedValue(networkError(new AggregateError([sysErr('ECONNREFUSED'), sysErr('ECONNRESET')])));
    await expect(refreshSession()).rejects.toBeInstanceOf(FakeRekeyError);
    expect(jar.has('rekey_refresh')).toBe(false);
  });
});

describe('the refresh route answers the same way', () => {
  const handlerReq = (cookie: string) =>
    new NextRequest(`https://app.example${DEFAULT_REFRESH_PATH}?next=%2Fdashboard`, { headers: { cookie } });
  const cleared = (res: Response) =>
    res.headers.getSetCookie().filter((l) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(l)).length;

  it.each([
    ['a timeout', () => new FakeRekeyError('REQUEST_TIMEOUT')],
    ['a 503', () => new FakeRekeyError('SERVICE_UNAVAILABLE', 503)],
    ['a bare network error', () => new FakeRekeyError('NETWORK_ERROR')],
  ])('%s: clears both, sends to sign-in with next and says it was interrupted', async (_label, make) => {
    refresh.mockRejectedValue(make());
    const res = await rekeyRefreshHandler()(handlerReq(`rekey_refresh=${R1}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fdashboard&reason=session_interrupted');
    expect(cleared(res)).toBe(2);
  });

  it('connection refused: 503, cookies untouched', async () => {
    refresh.mockRejectedValue(networkError(sysErr('ECONNREFUSED')));
    const res = await rekeyRefreshHandler()(handlerReq(`rekey_refresh=${R1}`));
    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('auth(), refreshSession() and the refresh route share one exchange', () => {
  it('a Server Action and a concurrent page load spend the token once', async () => {
    let release!: (v: { accessToken: string; refreshToken: string }) => void;
    refresh.mockReturnValue(new Promise((r) => (release = r)));
    jar.set('rekey_refresh', { value: R1 });

    const inAction = auth();
    const inRoute = rekeyRefreshHandler()(
      new NextRequest(`https://app.example${DEFAULT_REFRESH_PATH}?next=%2F`, {
        headers: { cookie: `rekey_refresh=${R1}` },
      }),
    );
    // Let both reach the exchange before it settles.
    await new Promise((r) => setTimeout(r, 10));
    release({ accessToken: 'a2', refreshToken: 'r2' });

    const [session, res] = await Promise.all([inAction, inRoute]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(session?.accessToken).toBe('a2');
    expect(res.headers.getSetCookie().find((l) => l.startsWith('rekey_refresh='))).toMatch(/^rekey_refresh=r2;/);
  });

  it('refreshSession() after the route finished asks the API, and is never handed the route\'s pair', async () => {
    refresh
      .mockResolvedValueOnce({ accessToken: 'a2', refreshToken: 'r2' })
      .mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_RACED', 401));
    await rekeyRefreshHandler()(
      new NextRequest(`https://app.example${DEFAULT_REFRESH_PATH}`, { headers: { cookie: `rekey_refresh=${R1}` } }),
    );

    // A second tab's action, still holding the old cookie.
    jar.set('rekey_refresh', { value: R1 });
    await expect(refreshSession()).rejects.toMatchObject({ code: 'REFRESH_TOKEN_RACED' });

    expect(refresh).toHaveBeenCalledTimes(2);
    // Kept for the retry, which sends whatever the browser holds by then.
    expect(jar.get('rekey_refresh')?.value).toBe(R1);
    expect(jar.get('rekey_access')).toBeUndefined();
    expect(jar.get('rekey_refresh_raced')?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('two concurrent auth() calls rotate once', async () => {
    let release!: (v: { accessToken: string; refreshToken: string }) => void;
    refresh.mockReturnValue(new Promise((r) => (release = r)));
    jar.set('rekey_refresh', { value: R1 });
    const both = Promise.all([auth(), auth()]);
    await new Promise((r) => setTimeout(r, 10));
    release({ accessToken: 'a2', refreshToken: 'r2' });
    await both;
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('the exchange map never holds a refresh token', () => {
  it('keys it by SHA-256', async () => {
    const setSpy = vi.spyOn(Map.prototype, 'set');
    try {
      refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
      jar.set('rekey_refresh', { value: R1 });
      await refreshSession();
      const keys = setSpy.mock.calls.map((c) => c[0]);
      expect(keys).not.toContain(R1);
      const { createHash } = await import('node:crypto');
      expect(keys).toContain(createHash('sha256').update(R1).digest('hex'));
    } finally {
      setSpy.mockRestore();
    }
  });
});

describe('the access cookie lives as long as its token', () => {
  const now = Math.floor(Date.now() / 1000);

  it('a 60-second token gets a 60-second cookie from auth()', async () => {
    const access = jwt({ iat: now, exp: now + 60 });
    refresh.mockResolvedValue({ accessToken: access, refreshToken: 'r2' });
    jar.set('rekey_refresh', { value: R1 });
    await auth();
    expect(jar.get('rekey_access')?.opts?.maxAge).toBeGreaterThanOrEqual(59);
    expect(jar.get('rekey_access')?.opts?.maxAge).toBeLessThanOrEqual(60);
  });

  it('and from the refresh route', async () => {
    refresh.mockResolvedValue({ accessToken: jwt({ iat: now, exp: now + 60 }), refreshToken: 'r2' });
    const res = await rekeyRefreshHandler()(
      new NextRequest(`https://app.example${DEFAULT_REFRESH_PATH}`, { headers: { cookie: `rekey_refresh=${R1}` } }),
    );
    const line = res.headers.getSetCookie().find((l) => l.startsWith('rekey_access='));
    expect(line).toMatch(/Max-Age=(59|60)\b/);
  });

  it('a clock here running ahead of the API cannot shrink it to nothing', async () => {
    // Minted ten minutes "ago" by this host's clock. The token's own lifetime
    // still holds, rather than a zero-second cookie that sends every request
    // through the refresh route.
    const minted = now - 600;
    refresh.mockResolvedValue({ accessToken: jwt({ iat: minted, exp: minted + 60 }), refreshToken: 'r2' });
    jar.set('rekey_refresh', { value: R1 });
    await refreshSession();
    expect(jar.get('rekey_access')?.opts?.maxAge).toBe(60);
  });

  it('a token that is not a readable JWT falls back to accessTokenExpiresAt', async () => {
    signInRemote.mockResolvedValue({
      mfaRequired: false,
      endUser: USER,
      accessToken: 'opaque',
      refreshToken: 'r2',
      accessTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    await signIn({ email: 'a@b.c', password: 'pw' });
    expect(jar.get('rekey_access')?.opts?.maxAge).toBeGreaterThanOrEqual(119);
    expect(jar.get('rekey_access')?.opts?.maxAge).toBeLessThanOrEqual(120);
  });
});

describe('one /users/me per access token per request', () => {
  it('a layout and a page calling auth() cost one read', async () => {
    jar.set('rekey_access', { value: 'a1' });
    await auth();
    await auth();
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('the next request reads again', async () => {
    jar.set('rekey_access', { value: 'a1' });
    await auth();
    newRequest();
    await auth();
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });

  it('a refresh in the same request reads the new token, not the cached old one', async () => {
    jar.set('rekey_access', { value: 'a1' });
    jar.set('rekey_refresh', { value: R1 });
    getCurrentUser.mockReset();
    getCurrentUser.mockImplementation(async (token: string) => {
      if (token === 'a1') throw new FakeRekeyError('USER_TOKEN_INVALID');
      return { ...USER, token };
    });
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });

    const session = await auth();

    expect(session).toMatchObject({ accessToken: 'a2', user: { token: 'a2' } });
    expect(getCurrentUser.mock.calls.map((c) => c[0])).toEqual(['a1', 'a2']);
  });
});
