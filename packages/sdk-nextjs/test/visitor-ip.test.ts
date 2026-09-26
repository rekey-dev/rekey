/**
 * The sign-in helpers forward the visitor's address, so the API's per-IP
 * sign-in limit counts the visitor rather than the app's server. Without it
 * every sign-in an app makes arrives from one address.
 *
 * Also here: a proxy 5xx during an in-place refresh keeps the cookies, since
 * it never reached the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let requestHeaders = new Headers();
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

const signIn = vi.fn();
const signUp = vi.fn();
const mfaVerify = vi.fn();
const refresh = vi.fn();
const getCurrentUser = vi.fn();
/** The `clientIp` each scoped client was made with, in order. */
const scopedWith: Array<string | undefined> = [];

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => requestHeaders,
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@rekey.dev/node', () => ({
  Rekey: class {
    auth = { signIn, signUp, mfaVerify, refresh, getCurrentUser };
    with(opts: { clientIp?: string }) {
      scopedWith.push(opts.clientIp);
      return this;
    }
  },
  RekeyError: FakeRekeyError,
}));

const server = await import('../src/server.js');

const session = { accessToken: 'a', refreshToken: 'r', endUser: { id: 'u' } };

beforeEach(() => {
  jar.clear();
  scopedWith.length = 0;
  for (const f of [signIn, signUp, mfaVerify, refresh, getCurrentUser]) f.mockReset();
  signIn.mockResolvedValue({ ...session, mfaRequired: false });
  signUp.mockResolvedValue(session);
  mfaVerify.mockResolvedValue(session);
  delete process.env.REKEY_TRUSTED_PROXY_HOPS;
  process.env.REKEY_SECRET = 'rp_test_x';
  process.env.REKEY_URL = 'https://api.test.invalid';
  requestHeaders = new Headers({ host: 'app.example' });
});

describe('visitorIpFrom', () => {
  it('takes the entry the proxy wrote, not the one the visitor typed', () => {
    const h = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    expect(server.visitorIpFrom(h)).toBe('203.0.113.9');
    expect(server.visitorIpFrom(h, 2)).toBe('6.6.6.6');
  });

  it('refuses a chain shorter than the configured hops', () => {
    expect(server.visitorIpFrom(new Headers({ 'x-forwarded-for': '203.0.113.9' }), 2)).toBeNull();
  });

  it('falls back to X-Real-IP, and 0 hops sends nothing', () => {
    expect(server.visitorIpFrom(new Headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(server.visitorIpFrom(new Headers({ 'x-real-ip': '198.51.100.4' }), 0)).toBeNull();
  });
});

describe('signIn, signUp and mfaVerify forward the visitor', () => {
  it.each([
    ['signIn', () => server.signIn({ email: 'a@b.co', password: 'pw' })],
    ['signUp', () => server.signUp({ email: 'a@b.co', password: 'pw' })],
    ['mfaVerify', () => server.mfaVerify({ mfaChallengeToken: 't', code: '123456' })],
  ])('%s', async (_name, call) => {
    requestHeaders = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    await call();
    expect(scopedWith).toEqual(['203.0.113.9']);
  });

  it('REKEY_TRUSTED_PROXY_HOPS picks the entry', async () => {
    process.env.REKEY_TRUSTED_PROXY_HOPS = '2';
    requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.9, 104.16.0.1' });
    await server.signIn({ email: 'a@b.co', password: 'pw' });
    expect(scopedWith).toEqual(['203.0.113.9']);
  });

  it('an explicit clientIp wins, and null sends none', async () => {
    requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.9' });
    await server.signIn({ email: 'a@b.co', password: 'pw' }, { clientIp: '198.51.100.7' });
    await server.signIn({ email: 'a@b.co', password: 'pw' }, { clientIp: null });
    expect(scopedWith).toEqual(['198.51.100.7']);
  });

  it('sends none when the request carries no address', async () => {
    await server.signIn({ email: 'a@b.co', password: 'pw' });
    expect(scopedWith).toEqual([]);
  });
});

describe('an in-place refresh through a proxy with no API behind it', () => {
  it.each([502, 503, 504])('%i without a Rekey envelope keeps both cookies', async (status) => {
    jar.set('rekey_refresh', `r_${status}_${Math.random()}`);
    const before = jar.get('rekey_refresh');
    refresh.mockRejectedValue(new FakeRekeyError('UNKNOWN_ERROR', status));
    await expect(server.refreshSession()).rejects.toBeInstanceOf(FakeRekeyError);
    expect(jar.get('rekey_refresh')).toBe(before);
  });

  it('a 503 the API answered clears them', async () => {
    jar.set('rekey_refresh', `r_api_${Math.random()}`);
    refresh.mockRejectedValue(new FakeRekeyError('SERVICE_UNAVAILABLE', 503));
    await expect(server.refreshSession()).rejects.toBeInstanceOf(FakeRekeyError);
    expect(jar.has('rekey_refresh')).toBe(false);
  });
});
