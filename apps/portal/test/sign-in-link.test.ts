/**
 * Signing in with an emailed link: asking for one never says whether the
 * address has an account, the link lands on a route that spends nothing, and
 * the "Sign in" button that spends it ends exactly like a password sign-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { RekeyError } from '@rekey.dev/react';

type Cookie = { value: string; options: Record<string, unknown> };
const jar = new Map<string, Cookie>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const c = jar.get(name);
      return c && c.options.maxAge !== 0 ? { name, value: c.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set(name, { value, options });
    },
  }),
  headers: async () => new Headers({ host: 'portal.example', 'x-forwarded-proto': 'https' }),
}));

const client = { verifyMagicLink: vi.fn() };

vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ publishableKey: 'pk_test', billingSubject: 'user' }),
  PortalConfigUnavailableError: class extends Error {},
}));
vi.mock('@/lib/env', () => ({
  portalBaseUrl: () => 'https://portal.example',
  rekeyApiUrl: () => 'https://api.example',
}));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({}),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  portalClientFor: async () => client,
}));

const session = await import('@/lib/session');
const { requestSignInLinkAction, signInWithLinkAction } = await import('@/lib/actions');
const { GET } = await import('@/app/(portal)/[slug]/sign-in-link/route');

const TOKEN = 'ml_raw_token_value';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const m = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}

function apiAnswers(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

const refusal = (code: string, status = 401) => new RekeyError({ code, message: code, status } as never);

async function landWithLink(): Promise<Response> {
  const res = await GET(new NextRequest(`https://portal.example/acme/sign-in-link?token=${TOKEN}`), {
    params: Promise.resolve({ slug: 'acme' }),
  });
  const set = res.headers.get('set-cookie') ?? '';
  const value = new RegExp(`${session.SIGN_IN_LINK}=([^;]*)`).exec(set)?.[1];
  if (value) jar.set(session.SIGN_IN_LINK, { value: decodeURIComponent(value), options: { maxAge: 900 } });
  return res;
}

beforeEach(() => {
  jar.clear();
  client.verifyMagicLink.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('requesting a sign-in link', () => {
  it('asks the API for a link that points at this portal, built from the configured base URL', async () => {
    const fetchSpy = apiAnswers(200, { success: true, data: { delivered: true, emailSent: true, magicLinkToken: null } });
    await redirectOf(() => requestSignInLinkAction('acme', form({ email: 'a@example.com' })));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/v1/auth/magic-link/request');
    expect(JSON.parse(String(init!.body))).toEqual({
      email: 'a@example.com',
      signInUrl: 'https://portal.example/acme/sign-in-link?token={token}',
    });
  });

  it('lands on the same neutral state for a known address, an unknown one and a refused one', async () => {
    const answers: Array<[number, unknown]> = [
      [200, { success: true, data: { delivered: true, emailSent: true, magicLinkToken: null } }],
      [200, { success: true, data: { delivered: false, emailSent: false, magicLinkToken: null } }],
      [400, { error: { code: 'VALIDATION_ERROR' } }],
      [403, { error: { code: 'SIGNUP_DISABLED' } }],
    ];
    for (const [status, body] of answers) {
      apiAnswers(status, body);
      const to = await redirectOf(() => requestSignInLinkAction('acme', form({ email: 'nobody@example.com' })));
      expect(to).toBe('/acme/login?link=sent');
      vi.restoreAllMocks();
    }
  });

  it('says so when the request was throttled or the service is down', async () => {
    apiAnswers(429, { error: { code: 'RATE_LIMITED', retryAfterSeconds: 600 } });
    expect(await redirectOf(() => requestSignInLinkAction('acme', form({ email: 'a@example.com' })))).toBe(
      '/acme/login?link_error=RATE_LIMITED&retry=600',
    );
    apiAnswers(503, { error: { code: 'DEPENDENCY_UNAVAILABLE' } });
    expect(await redirectOf(() => requestSignInLinkAction('acme', form({ email: 'a@example.com' })))).toBe(
      '/acme/login?link_error=DEPENDENCY_UNAVAILABLE',
    );
  });
});

describe('the sign-in link landing route', () => {
  it('moves the token into a short-lived httpOnly cookie and redirects to a token-free page', async () => {
    const res = await landWithLink();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/acme/login?step=link');
    expect(res.headers.get('location')).not.toContain(TOKEN);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain(`${session.SIGN_IN_LINK}=${TOKEN}`);
    expect(set).toMatch(/Path=\/acme/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Max-Age=900/);
  });

  it('spends nothing on a GET, so a mail scanner fetching the link cannot burn it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await landWithLink();
    expect(client.verifyMagicLink).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('signing in with the link', () => {
  it('sets the session cookies, clears the link and goes to the dashboard', async () => {
    await landWithLink();
    client.verifyMagicLink.mockResolvedValueOnce({ mfaRequired: false, accessToken: 'at', refreshToken: 'rt' });
    const to = await redirectOf(() => signInWithLinkAction('acme'));
    expect(to).toBe('/acme');
    expect(client.verifyMagicLink).toHaveBeenCalledWith({ token: TOKEN });
    expect(jar.get(session.ACCESS)?.value).toBe('at');
    expect(jar.get(session.REFRESH)?.value).toBe('rt');
    expect(jar.get(session.ACCESS)?.options).toMatchObject({ httpOnly: true, path: '/acme' });
    expect(jar.get(session.SIGN_IN_LINK)?.options.maxAge).toBe(0);
  });

  it('hands an MFA-enrolled account to the code step with the challenge cookie', async () => {
    await landWithLink();
    client.verifyMagicLink.mockResolvedValueOnce({ mfaRequired: true, mfaChallengeToken: 'challenge' });
    const to = await redirectOf(() => signInWithLinkAction('acme'));
    expect(to).toBe('/acme/login?step=mfa');
    expect(jar.get(session.MFA_CHALLENGE)?.value).toBe('challenge');
    expect(jar.get(session.ACCESS)).toBeUndefined();
  });

  it('sends an expired or used link back to sign in with its code', async () => {
    for (const code of ['MAGIC_LINK_EXPIRED', 'MAGIC_LINK_USED']) {
      await landWithLink();
      client.verifyMagicLink.mockRejectedValueOnce(refusal(code));
      expect(await redirectOf(() => signInWithLinkAction('acme'))).toBe(`/acme/login?error=${code}`);
      expect(jar.get(session.SIGN_IN_LINK)?.options.maxAge).toBe(0);
    }
  });

  it('with no link waiting, calls nothing and shows the link step again', async () => {
    expect(await redirectOf(() => signInWithLinkAction('acme'))).toBe('/acme/login?step=link');
    expect(client.verifyMagicLink).not.toHaveBeenCalled();
  });
});
