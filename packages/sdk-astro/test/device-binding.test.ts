/**
 * A rotation must identify the same machine the sign-in did.
 *
 * `getSession` refreshes, and it called `refresh(token)` with no device. For a
 * site whose clients bind at sign-in that is the unbound half of a bound
 * session: the API checks the fingerprint on every rotation, and a chain bound
 * at sign-in but refreshed anonymously never gets to prove it is the same
 * machine. A chain that should have become bound (a client that started
 * sending fingerprints mid-session) never does either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jar = new Map<string, string>();
const cookies = {
  get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
  set: (n: string, v: string) => void jar.set(n, v),
  delete: (n: string) => void jar.delete(n),
};

class FakeRekeyError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const getCurrentUser = vi.fn();
const refresh = vi.fn();

vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { getCurrentUser, refresh, signOut: vi.fn() };
  },
  RekeyError: FakeRekeyError,
}));

const { getSession } = await import('../src/index.js');

const req = (): Request => new Request('https://x/', { headers: { host: 'app.example' } });
const base = { secretKey: 'rp_test_x', apiUrl: 'https://api.example.test' };
const DEVICE = { fingerprint: 'sha256:aaaaaaaaaaaa', label: 'Work laptop' };

beforeEach(() => {
  jar.clear();
  getCurrentUser.mockReset();
  refresh.mockReset();
  getCurrentUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' });
  refresh.mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2' });
});

describe('the device reaches the refresh call', () => {
  it('sends the configured device when rotating', async () => {
    jar.set('rekey_refresh', 'rt1');

    await getSession(cookies, req(), { ...base, device: DEVICE });

    expect(refresh).toHaveBeenCalledWith('rt1', { device: DEVICE });
  });

  it('sends no device key at all when none is configured', async () => {
    jar.set('rekey_refresh', 'rt1');

    await getSession(cookies, req(), base);

    expect(refresh).toHaveBeenCalledWith('rt1');
  });
});
