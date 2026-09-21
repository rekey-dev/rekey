/**
 * A sign-in must be able to name the machine it came from.
 *
 * `authConfig.deviceBinding: 'required'` makes `device` mandatory on every
 * primary sign-in flow: without it the API answers `400
 * DEVICE_FINGERPRINT_REQUIRED` and no token is issued. `SignInRequest` has
 * carried `device` since devices shipped, and `@rekey.dev/node` passes it
 * straight through, but this package's `signIn` declared its input as exactly
 * `{ email, password }`, so a Next app had no way to send one. Sign-in through
 * this SDK could not succeed at all against such an Application, and the
 * failure was a compile error in the caller's own file, three layers from the
 * cause.
 *
 * The compile-time half of that is asserted in `device-binding-types.test-d.ts`
 * (type-checked by `tsconfig.test.json`, because a runtime test cannot see it:
 * an extra property on a plain object is forwarded by the spread either way).
 * This file asserts the half that is genuinely runtime: refresh, which built
 * its request body itself and had nowhere to put a device at all.
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

const signInRemote = vi.fn();
const signUpRemote = vi.fn();
const mfaVerifyRemote = vi.fn();
const refresh = vi.fn();
const getCurrentUser = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => new Headers({ host: 'app.example' }),
}));
vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = {
      signIn: signInRemote,
      signUp: signUpRemote,
      mfaVerify: mfaVerifyRemote,
      refresh,
      getCurrentUser,
    };
  },
  RekeyError: FakeRekeyError,
}));

const { signIn, signUp, mfaVerify, auth, refreshSession } = await import('../src/server.js');

const USER = { id: 'u1', email: 'a@b.c' };
const DEVICE = { fingerprint: 'sha256:aaaaaaaaaaaa', label: 'Work laptop' };
const SESSION = {
  mfaRequired: false,
  accessToken: 'at1',
  refreshToken: 'rt1',
  endUser: USER,
};

beforeEach(() => {
  jar.clear();
  for (const m of [signInRemote, signUpRemote, mfaVerifyRemote, refresh, getCurrentUser]) {
    m.mockReset();
  }
  getCurrentUser.mockResolvedValue(USER);
  process.env.REKEY_SECRET = 'rp_test_x';
  process.env.REKEY_URL = 'https://api.test.invalid';
});

describe('the device binding reaches the API', () => {
  it('signIn forwards the device', async () => {
    signInRemote.mockResolvedValue(SESSION);
    await signIn({ email: 'a@b.c', password: 'pw', device: DEVICE });
    expect(signInRemote).toHaveBeenCalledWith({
      email: 'a@b.c',
      password: 'pw',
      device: DEVICE,
    });
  });

  it('signUp forwards the device', async () => {
    signUpRemote.mockResolvedValue(SESSION);
    await signUp({ email: 'a@b.c', password: 'pw', device: DEVICE });
    expect(signUpRemote).toHaveBeenCalledWith({
      email: 'a@b.c',
      password: 'pw',
      device: DEVICE,
    });
  });

  it('mfaVerify forwards the device', async () => {
    mfaVerifyRemote.mockResolvedValue(SESSION);
    await mfaVerify({ mfaChallengeToken: 'ch1', code: '123456', device: DEVICE });
    expect(mfaVerifyRemote).toHaveBeenCalledWith({
      mfaChallengeToken: 'ch1',
      code: '123456',
      device: DEVICE,
    });
  });

  it('a caller who passes nothing sends no device key at all', async () => {
    // The old signature stays valid, and an absent device must not become
    // `device: undefined`: the API bodies are `.strict()`, and a key that is
    // present-but-undefined is a different thing from an absent one to a
    // validator once it has been through JSON.
    signInRemote.mockResolvedValue(SESSION);
    await signIn({ email: 'a@b.c', password: 'pw' });
    expect(signInRemote).toHaveBeenCalledWith({ email: 'a@b.c', password: 'pw' });
    expect(Object.keys(signInRemote.mock.calls[0]![0] as object)).not.toContain('device');
  });
});

describe('refresh carries the device too', () => {
  // The API binds a chain at sign-in and then checks it on every rotation: a
  // bound chain refreshed from a different fingerprint is
  // `REFRESH_TOKEN_DEVICE_MISMATCH` and revokes every session the user has.
  // Sending it on sign-in and then omitting it on refresh is therefore not a
  // small asymmetry. It is the unbound half of a bound session, and an
  // unbound chain that should have been bound never gets bound at all.
  it('refreshSession passes the configured device', async () => {
    jar.set('rekey_refresh', 'rt0');
    refresh.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2' });

    await refreshSession({ device: DEVICE });

    expect(refresh).toHaveBeenCalledWith('rt0', { device: DEVICE });
  });

  it('auth() passes the configured device when it rotates', async () => {
    jar.set('rekey_refresh', 'rt0');
    refresh.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2' });

    await auth({ device: DEVICE });

    expect(refresh).toHaveBeenCalledWith('rt0', { device: DEVICE });
  });

  it('no device given means the call is byte-for-byte what it always was', async () => {
    jar.set('rekey_refresh', 'rt0');
    refresh.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2' });

    await refreshSession();

    expect(refresh).toHaveBeenCalledWith('rt0');
  });
});
