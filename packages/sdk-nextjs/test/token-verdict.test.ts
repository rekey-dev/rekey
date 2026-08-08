/**
 * A dead refresh token must be cleared, whichever way the API says it is dead.
 *
 * The terminal-code list used to hold three entries — EXPIRED, REUSED and
 * USER_TOKEN_INVALID — while `/auth/refresh` throws six. The two that mattered
 * most were the two missing: REVOKED is what "sign out my other devices"
 * produces, and INVALID is any stale cookie, a restored database, or an app
 * rebuilt from scratch.
 *
 * A code outside the list fell through to "the API failed", which deliberately
 * leaves the cookies alone so a blip cannot log everybody out. For a token that
 * is genuinely finished that is the wrong half of the trade: the cookie is
 * never cleared, so the browser re-presents a corpse on every request for the
 * next thirty days, each one a doomed round-trip and a log line, while the user
 * looks at a signed-out page and has no way to fix it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jar = new Map<string, string>();
const cookieJar = {
  get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
  set: (n: string, v: string) => void jar.set(n, v),
  delete: (n: string) => void jar.delete(n),
};

class FakeRekeyError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const refresh = vi.fn();
const getCurrentUser = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  // The success path writes cookies, which decides `Secure` from the host.
  headers: async () => new Headers({ host: 'app.example' }),
}));
vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { refresh, getCurrentUser };
  },
  RekeyError: FakeRekeyError,
}));

const { auth } = await import('../src/server.js');

beforeEach(() => {
  jar.clear();
  refresh.mockReset();
  getCurrentUser.mockReset();
  process.env.REKEY_SECRET = 'rp_test_x';
  process.env.REKEY_URL = 'https://api.test.invalid';
});

describe('every terminal refresh code clears the session', () => {
  it.each([
    'REFRESH_TOKEN_EXPIRED',
    'REFRESH_TOKEN_INVALID',
    'REFRESH_TOKEN_REUSED',
    'REFRESH_TOKEN_REVOKED',
    'REFRESH_TOKEN_RACE',
    'REFRESH_TOKEN_WRONG_APPLICATION',
  ])('%s', async (code) => {
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError(code));

    await expect(auth()).resolves.toBeNull();
    expect(jar.has('rekey_refresh')).toBe(false);
  });
});

describe('a failed request is still not a verdict', () => {
  it('keeps the refresh cookie when the API was merely unreachable', async () => {
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError('REQUEST_TIMEOUT'));

    await expect(auth()).rejects.toBeInstanceOf(FakeRekeyError);
    expect(jar.get('rekey_refresh')).toBe('r1');
  });
});

describe('a wrong-application access token refreshes instead of looping', () => {
  it('falls through to refresh rather than rethrowing forever', async () => {
    jar.set('rekey_access', 'a1');
    jar.set('rekey_refresh', 'r1');
    getCurrentUser
      .mockRejectedValueOnce(new FakeRekeyError('USER_TOKEN_WRONG_APPLICATION'))
      .mockResolvedValue({ id: 'u1' });
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });

    await expect(auth()).resolves.toMatchObject({ user: { id: 'u1' } });
  });
});
