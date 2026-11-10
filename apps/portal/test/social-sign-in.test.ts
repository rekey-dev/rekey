/**
 * Social sign-in through the portal: starting it binds a state to this
 * browser, and the landing page spends the provider's code on the server,
 * never putting a session token in a URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ slug: 'acme', publishableKey: 'rp_pub_test', billingSubject: 'user' }),
  PortalConfigUnavailableError: class extends Error {},
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({ 'x-rekey-caller-secret': 'portal-secret' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const session = await import('@/lib/session');
const { SOCIAL_SIGN_IN, socialSignInProviders } = await import('@/lib/social-sign-in');
const { startSocialSignInAction } = await import('@/lib/social-sign-in-actions');
const { GET } = await import('@/app/(portal)/[slug]/oauth/callback/route');

const RETURN_URL = 'https://portal.example/acme/oauth/callback';
const calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];

function serve(routes: Record<string, () => Response>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (init?.body) calls.push({ path: url.pathname, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    return route ? route() : new Response('{}', { status: 404 });
  });
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const PROVIDERS = json(200, {
  success: true,
  data: {
    providers: [
      { id: 'google', name: 'Google', hostedPortal: true },
      { id: 'github', name: 'GitHub', hostedPortal: false },
    ],
  },
});

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

function start(provider = 'google', fields: Record<string, string> = {}): Promise<string> {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return redirectOf(() => startSocialSignInAction('acme', provider, f));
}

function land(query: string): Promise<string> {
  const req = new NextRequest(`https://portal.example/acme/oauth/callback?${query}`);
  return redirectOf(() => GET(req, { params: Promise.resolve({ slug: 'acme' }) }));
}

const heldState = () => jar.get(SOCIAL_SIGN_IN)!.value.split('.')[1]!;

beforeEach(() => {
  jar.clear();
  calls.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('starting a social sign-in', () => {
  it('keeps a fresh state for this browser and asks the API for the URL that returns to this portal', async () => {
    serve({
      'GET /api/v1/auth/oauth/providers': PROVIDERS,
      'POST /api/v1/auth/oauth/google/start': json(200, { success: true, data: { authorizationUrl: 'https://accounts.example/auth' } }),
    });
    expect(await start('google', { return: 'devices' })).toBe('https://accounts.example/auth');
    const held = jar.get(SOCIAL_SIGN_IN)!;
    expect(held.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/acme', maxAge: 600 });
    expect(held.value).toMatch(/^google\.[A-Za-z0-9_-]{43}$/);
    expect(calls[0]!.body).toEqual({ state: heldState(), redirectUri: RETURN_URL });
    expect(jar.get(session.SIGN_IN_RETURN)?.value).toBe('devices');
  });

  it('refuses a provider the application does not offer without asking the API to start it', async () => {
    serve({ 'GET /api/v1/auth/oauth/providers': PROVIDERS });
    expect(await start('evil')).toBe('/acme/login?social_error=OAUTH_PROVIDER_UNKNOWN&provider=evil');
    expect(calls).toEqual([]);
  });

  it('offers only providers the operator turned on for the portal, and will not start any other', async () => {
    serve({ 'GET /api/v1/auth/oauth/providers': PROVIDERS });
    expect((await socialSignInProviders('acme')).map((p) => p.id)).toEqual(['google']);
    expect(await start('github')).toBe('/acme/login?social_error=OAUTH_PROVIDER_UNKNOWN&provider=github');
    expect(calls).toEqual([]);
  });
});

describe('the landing page', () => {
  async function started(): Promise<string> {
    serve({
      'GET /api/v1/auth/oauth/providers': PROVIDERS,
      'POST /api/v1/auth/oauth/google/start': json(200, { success: true, data: { authorizationUrl: 'https://a.example' } }),
    });
    await start('google', { return: 'devices' });
    vi.restoreAllMocks();
    calls.length = 0;
    return heldState();
  }

  it('refuses a state this browser did not start, without spending the code', async () => {
    await started();
    serve({});
    expect(await land('code=c&state=forged')).toBe('/acme/login?social_error=OAUTH_STATE_MISMATCH&provider=');
    expect(calls).toEqual([]);
  });

  it('accepts a state once: the cookie is gone after the first landing', async () => {
    const state = await started();
    serve({ 'POST /api/v1/auth/oauth/google/callback': json(400, { error: { code: 'OAUTH_TOKEN_EXCHANGE_FAILED' } }) });
    await land(`code=c&state=${state}`);
    expect(await land(`code=c&state=${state}`)).toContain('OAUTH_STATE_MISMATCH');
  });

  it('says the sign-in was canceled when the provider sends an error instead of a code', async () => {
    const state = await started();
    serve({});
    expect(await land(`error=access_denied&state=${state}`)).toBe(
      '/acme/login?social_error=OAUTH_CANCELED&provider=google',
    );
  });

  it('spends the code on the server with the caller secret and signs in, the session going only into cookies', async () => {
    const state = await started();
    serve({
      'POST /api/v1/auth/oauth/google/callback': json(200, {
        success: true,
        data: { mfaRequired: false, accessToken: 'at', refreshToken: 'rt' },
      }),
    });
    const to = await land(`code=provider-code&state=${state}`);
    expect(to).toBe('/acme/devices');
    expect(to).not.toContain('at');
    expect(calls[0]!.body).toEqual({ code: 'provider-code', redirectUri: RETURN_URL });
    expect(calls[0]!.headers.get('x-rekey-caller-secret')).toBe('portal-secret');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer rp_pub_test');
    expect(jar.get(session.ACCESS)?.value).toBe('at');
  });

  it('goes on to the code step for an account with two-factor', async () => {
    const state = await started();
    serve({
      'POST /api/v1/auth/oauth/google/callback': json(200, {
        success: true,
        data: { mfaRequired: true, mfaChallengeToken: 'challenge' },
      }),
    });
    expect(await land(`code=c&state=${state}`)).toBe('/acme/login?step=mfa');
    expect(jar.get(session.MFA_CHALLENGE)?.value).toBe('challenge');
  });

  it.each([
    ['OAUTH_EMAIL_NOT_VERIFIED', '/acme/login?social_error=OAUTH_EMAIL_NOT_VERIFIED&provider=google'],
    ['EMAIL_NOT_VERIFIED', '/acme/login?error=EMAIL_NOT_VERIFIED'],
  ])('sends %s to the sign-in page that explains it', async (code, path) => {
    const state = await started();
    serve({ 'POST /api/v1/auth/oauth/google/callback': json(401, { error: { code } }) });
    expect(await land(`code=c&state=${state}`)).toBe(path);
  });
});
