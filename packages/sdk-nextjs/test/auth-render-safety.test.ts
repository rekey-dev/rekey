/**
 * `auth()` must not throw because of where it was called.
 *
 * It refreshes an expired access token by writing cookies, and Next seals the
 * cookie jar outside an action or route handler — `set` and `delete` both
 * throw there. Since `auth()` is documented for use in server components, and
 * the access cookie lasts fifteen minutes while the refresh cookie lasts
 * thirty days, every signed-in user hit this a quarter of an hour after
 * signing in: an exception out of the root layout, which with no error
 * boundary is a 500 on every route including the sign-in page. The user could
 * not reach any page that would fix it.
 *
 * The write is attempted and its failure ignored: the session is still
 * returned for this request, and `refreshSession()` exists for the places
 * allowed to persist it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SEALED = 'Cookies can only be modified in a Server Action or Route Handler';

const jar = new Map<string, string>();
let sealed = true;

const cookieJar = {
  get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
  set: (n: string, v: string) => {
    if (sealed) throw new Error(SEALED);
    jar.set(n, v);
  },
  delete: (n: string) => {
    if (sealed) throw new Error(SEALED);
    jar.delete(n);
  },
};

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => new Headers({ 'x-forwarded-proto': 'https', host: 'app.example' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

const getCurrentUser = vi.fn();
const refresh = vi.fn();
class FakeRekeyError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { getCurrentUser, refresh };
  },
  RekeyError: FakeRekeyError,
}));

process.env.REKEY_URL = 'https://api.example';
process.env.REKEY_SECRET = 'rp_test_x';

const { auth } = await import('../src/server.js');

const USER = { id: 'u1', email: 'a@b.c' };

beforeEach(() => {
  jar.clear();
  sealed = true;
  getCurrentUser.mockReset();
  refresh.mockReset();
});

describe('auth() during a render, with the cookie jar sealed', () => {
  it('does not throw, and does not spend a token it cannot store', async () => {
    jar.set('rekey_refresh', 'r1');
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    getCurrentUser.mockResolvedValue(USER);

    const session = await auth();

    // Reports no session for this render. The middleware repairs it through a
    // route handler before the next one.
    expect(session).toBeNull();

    // The important half. The API rotates on every refresh and treats a replay
    // of the rotated token as compromise — `revokeAllForEndUser`. Refreshing
    // here would leave the browser holding the old token, and the next request
    // would sign the user out of every device.
    expect(refresh).not.toHaveBeenCalled();
    expect(jar.get('rekey_refresh')).toBe('r1');
  });

  it('returns null rather than throwing when the refresh token is spent', async () => {
    sealed = false;
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_EXPIRED'));
    await expect(auth()).resolves.toBeNull();
  });

  it('persists when the jar is writable', async () => {
    sealed = false;
    jar.set('rekey_refresh', 'r1');
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
    getCurrentUser.mockResolvedValue(USER);

    await auth();

    expect(jar.get('rekey_access')).toBe('a2');
    expect(jar.get('rekey_refresh')).toBe('r2');
  });
});

describe('auth() distinguishes a dead token from a bad day', () => {
  it('rethrows a transport failure rather than reporting a signed-out user', async () => {
    sealed = false;
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError('NETWORK_ERROR'));
    // Reporting an outage as "signed out" is how a blip becomes a mass logout.
    await expect(auth()).rejects.toBeInstanceOf(FakeRekeyError);
  });

  it('keeps the refresh cookie when the failure was not the token', async () => {
    sealed = false;
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError('REQUEST_TIMEOUT'));
    await expect(auth()).rejects.toThrow();
    expect(jar.get('rekey_refresh')).toBe('r1');
  });

  it('clears both cookies when the token really is finished', async () => {
    sealed = false;
    jar.set('rekey_access', 'a1');
    jar.set('rekey_refresh', 'r1');
    // The access token has to be rejected first, or auth() returns on it and
    // never reaches the refresh branch under test.
    getCurrentUser.mockRejectedValue(new FakeRekeyError('USER_TOKEN_INVALID'));
    refresh.mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_REUSED'));

    await expect(auth()).resolves.toBeNull();

    expect(jar.has('rekey_access')).toBe(false);
    expect(jar.has('rekey_refresh')).toBe(false);
  });

  it('returns null with no refresh cookie at all', async () => {
    await expect(auth()).resolves.toBeNull();
  });

  it('uses a valid access token without refreshing', async () => {
    jar.set('rekey_access', 'a1');
    getCurrentUser.mockResolvedValue(USER);
    expect(await auth()).toEqual({ user: USER, accessToken: 'a1' });
    expect(refresh).not.toHaveBeenCalled();
  });
});
