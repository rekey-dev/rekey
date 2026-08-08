/**
 * The two rules this package exists to hold, plus the redirect guard.
 *
 * Both were application code in the Astro starter, and both fail in the silent
 * direction when you get them wrong: an API blip that deletes everybody's
 * refresh cookie, and a session credential travelling in cleartext.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jar = new Map<string, string>();
const realSet = (n: string, v: string): void => void jar.set(n, v);
const realDel = (n: string): void => void jar.delete(n);
const setSpy = vi.fn(realSet);
const delSpy = vi.fn(realDel);
const cookies = {
  get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
  set: setSpy,
  delete: delSpy,
};

class FakeRekeyError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const getCurrentUser = vi.fn();
const refresh = vi.fn();
const signOutRemote = vi.fn();

vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { getCurrentUser, refresh, signOut: signOutRemote };
  },
  RekeyError: FakeRekeyError,
}));

const { getSession, setSession, signOut, safePath, rekeyMiddleware, rekey, RekeyAstroConfigError } =
  await import('../src/index.js');

const req = (headers: Record<string, string> = {}) => new Request('https://x/', { headers });
const cfg = { secretKey: 'rp_test_x' };
const USER = { id: 'u1', email: 'a@b.c' };

beforeEach(() => {
  jar.clear();
  // mockReset, not mockClear: a `mockImplementationOnce` that a test queued but
  // did not consume would otherwise fire inside the next one.
  setSpy.mockReset().mockImplementation(realSet);
  delSpy.mockReset().mockImplementation(realDel);
  getCurrentUser.mockReset();
  refresh.mockReset();
  signOutRemote.mockReset();
});

describe('a bad afternoon must not cost everyone their session', () => {
  it('keeps the refresh cookie when the API merely failed', async () => {
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError('REQUEST_TIMEOUT'));

    await expect(getSession(cookies, req(), cfg)).rejects.toBeInstanceOf(FakeRekeyError);
    // The one credential that can recover the session is still there.
    expect(jar.get('rekey_refresh')).toBe('r1');
    // The write probe deletes a cookie nothing sets; no session cookie goes.
    expect(delSpy.mock.calls.map((c) => c[0])).not.toContain('rekey_refresh');
  });

  it.each([
    'REFRESH_TOKEN_EXPIRED',
    'REFRESH_TOKEN_INVALID',
    'REFRESH_TOKEN_REUSED',
    'REFRESH_TOKEN_REVOKED',
    'REFRESH_TOKEN_RACE',
    'REFRESH_TOKEN_WRONG_APPLICATION',
  ])('clears on %s — every one of these is a verdict', async (code) => {
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError(code));

    await expect(getSession(cookies, req(), cfg)).resolves.toBeNull();
    expect(jar.has('rekey_refresh')).toBe(false);
  });

  it('never spends a refresh token it cannot store the replacement for', async () => {
    // Astro throws from cookies.set() once the response has started. Spending
    // the token anyway leaves the browser holding a revoked credential, and
    // replaying it revokes every session the user has on every device.
    jar.set('rekey_refresh', 'r1');
    setSpy.mockImplementationOnce(() => {
      throw new Error('ResponseSentError');
    });
    delSpy.mockImplementationOnce(() => {
      throw new Error('ResponseSentError');
    });

    await expect(getSession(cookies, req(), cfg)).resolves.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes on a wrong-application access token instead of looping forever', async () => {
    jar.set('rekey_access', 'a1');
    jar.set('rekey_refresh', 'r1');
    getCurrentUser
      .mockRejectedValueOnce(new FakeRekeyError('USER_TOKEN_WRONG_APPLICATION'))
      .mockResolvedValue(USER);
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });

    await expect(getSession(cookies, req(), cfg)).resolves.toEqual({
      user: USER,
      accessToken: 'a2',
    });
  });

  it('middleware degrades to signed out rather than taking down every route', async () => {
    jar.set('rekey_refresh', 'r1');
    refresh.mockRejectedValue(new FakeRekeyError('NETWORK_ERROR'));
    const ctx = { cookies, request: req(), locals: {} as Record<string, unknown> };

    const res = await rekeyMiddleware(cfg)(ctx, async () => new Response('ok'));

    expect(await res.text()).toBe('ok');
    expect(ctx.locals.session).toBeNull();
  });
});

describe('Secure is a per-request decision', () => {
  const secureOf = () => (setSpy.mock.calls[0]?.[2] as { secure: boolean }).secure;

  it('is set behind a TLS-terminating proxy', () => {
    setSession(cookies, req({ 'x-forwarded-proto': 'https', host: 'app.example' }), { accessToken: 'a', refreshToken: 'r' }, cfg);
    expect(secureOf()).toBe(true);
  });

  it('is not set on localhost, which browsers already treat as secure', () => {
    setSession(cookies, req({ host: 'localhost:4321' }), { accessToken: 'a', refreshToken: 'r' }, cfg);
    expect(secureOf()).toBe(false);
  });

  it('leans secure on an unknown host rather than risking cleartext', () => {
    setSession(cookies, req({ host: 'app.example' }), { accessToken: 'a', refreshToken: 'r' }, cfg);
    expect(secureOf()).toBe(true);
  });

  it('ignores x-forwarded-host, which a client can send', () => {
    // Letting it decide would let anyone ask for a cookie without Secure.
    setSession(cookies, req({ host: 'app.example', 'x-forwarded-host': 'localhost' }), { accessToken: 'a', refreshToken: 'r' }, cfg);
    expect(secureOf()).toBe(true);
  });
});

describe('setSession refuses a token-less outcome', () => {
  // signIn's MFA arm type-checks here because the shared DTOs infer from Zod
  // schemas typed as `any`. Only a runtime check stops it.
  it('throws rather than writing undefined into a session cookie', () => {
    const mfaOutcome = { mfaRequired: true, mfaChallengeToken: 'c1' } as unknown as {
      accessToken: string;
      refreshToken: string;
    };

    expect(() => setSession(cookies, req(), mfaOutcome, cfg)).toThrow(/mfaRequired/);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('sign-out revokes, not just clears', () => {
  it('revokes the refresh token server-side', async () => {
    jar.set('rekey_refresh', 'r1');
    signOutRemote.mockResolvedValue(undefined);

    await signOut(cookies, cfg);

    expect(signOutRemote).toHaveBeenCalledWith('r1');
    expect(jar.has('rekey_refresh')).toBe(false);
  });

  it('clears but reports failure when the API was unreachable', async () => {
    // The credential is still live for thirty days. Telling the caller it is
    // gone is the same collapse of "failed" into "verdict" that getSession
    // exists to refuse.
    jar.set('rekey_refresh', 'r1');
    signOutRemote.mockRejectedValue(new FakeRekeyError('REQUEST_TIMEOUT'));

    const result = await signOut(cookies, cfg);

    expect(result.revoked).toBe(false);
    expect(jar.has('rekey_refresh')).toBe(false);
  });

  it('reports success when the token was already dead', async () => {
    jar.set('rekey_refresh', 'r1');
    signOutRemote.mockRejectedValue(new FakeRekeyError('REFRESH_TOKEN_EXPIRED'));

    await expect(signOut(cookies, cfg)).resolves.toEqual({ revoked: true });
  });
});

describe('safePath', () => {
  it('blocks the forms that look internal and are not', () => {
    for (const evil of ['//evil.com', '/\\evil.com', 'https://evil.com', '/\\/evil.com']) {
      expect(safePath(evil, '/home')).toBe('/home');
    }
  });

  it('keeps a genuine path and its query', () => {
    expect(safePath('/dashboard?tab=usage', '/home')).toBe('/dashboard?tab=usage');
  });

  it('falls back on empty input', () => {
    expect(safePath(undefined, '/home')).toBe('/home');
  });

  it("falls back on String(form.get('next')) for an absent field", () => {
    // Yields the literal "null", which is truthy and resolves to /null.
    const form = new FormData();
    expect(safePath(String(form.get('next')), '/home')).toBe('/home');
  });
});

describe('the happy path still works', () => {
  it('returns the user for a valid access token without refreshing', async () => {
    jar.set('rekey_access', 'a1');
    getCurrentUser.mockResolvedValue(USER);

    expect(await getSession(cookies, req(), cfg)).toEqual({ user: USER, accessToken: 'a1' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes and persists when the access token has expired', async () => {
    jar.set('rekey_access', 'a1');
    jar.set('rekey_refresh', 'r1');
    getCurrentUser.mockRejectedValueOnce(new FakeRekeyError('USER_TOKEN_INVALID')).mockResolvedValue(USER);
    refresh.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });

    expect(await getSession(cookies, req(), cfg)).toEqual({ user: USER, accessToken: 'a2' });
    expect(jar.get('rekey_access')).toBe('a2');
    expect(jar.get('rekey_refresh')).toBe('r2');
  });

  it('is null with no cookies at all', async () => {
    expect(await getSession(cookies, req(), cfg)).toBeNull();
  });
});

describe('a misconfigured deploy stays loud', () => {
  it('does not disguise a missing secret as everybody being signed out', async () => {
    const ctx = { cookies, request: req(), locals: {} as Record<string, unknown> };

    await expect(rekeyMiddleware({})(ctx, async () => new Response('ok'))).rejects.toBeInstanceOf(
      RekeyAstroConfigError,
    );
  });

  it("does not hand a second Application the first one's client", () => {
    const a = rekey({ secretKey: 'rp_test_a' });
    const b = rekey({ secretKey: 'rp_test_b' });
    expect(a).not.toBe(b);
  });
});
