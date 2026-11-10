/**
 * Confirming an email address: asking for a new link never says whether the
 * address has an account, the emailed link lands on a route that spends
 * nothing, and the button that spends it says what happened.
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

const session = await import('@/lib/session');
const { resendVerificationAction, confirmEmailAction } = await import('@/lib/actions');
const { GET } = await import('@/app/(portal)/[slug]/verify-email/route');
const { middleware } = await import('@/middleware');

const TOKEN = 'ev_raw_token_value';

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

async function landWithLink(): Promise<Response> {
  const res = await GET(new NextRequest(`https://portal.example/acme/verify-email?token=${TOKEN}`), {
    params: Promise.resolve({ slug: 'acme' }),
  });
  const set = res.headers.get('set-cookie') ?? '';
  const value = new RegExp(`${session.VERIFY_EMAIL_LINK}=([^;]*)`).exec(set)?.[1];
  if (value) jar.set(session.VERIFY_EMAIL_LINK, { value: decodeURIComponent(value), options: { maxAge: 3600 } });
  return res;
}

beforeEach(() => jar.clear());
afterEach(() => vi.restoreAllMocks());

describe('asking for a new confirmation link', () => {
  it('asks the API for a link that points at this portal, built from the configured base URL', async () => {
    const fetchSpy = apiAnswers(200, { success: true, data: { emailSent: true, verificationToken: null } });
    await redirectOf(() => resendVerificationAction('acme', 'login', form({ email: 'a@example.com' })));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/v1/auth/resend-verification');
    expect(JSON.parse(String(init!.body))).toEqual({
      email: 'a@example.com',
      verifyUrl: 'https://portal.example/acme/verify-email?token={token}',
    });
  });

  it('lands on the same neutral state for a known address, an unknown one and a refused one', async () => {
    const answers: Array<[number, unknown]> = [
      [200, { success: true, data: { emailSent: true, verificationToken: null } }],
      [200, { success: true, data: { emailSent: false, verificationToken: null } }],
      [400, { error: { code: 'VALIDATION_ERROR' } }],
    ];
    for (const [status, body] of answers) {
      apiAnswers(status, body);
      expect(await redirectOf(() => resendVerificationAction('acme', 'login', form({ email: 'x@example.com' })))).toBe(
        '/acme/login?resend=sent',
      );
      expect(await redirectOf(() => resendVerificationAction('acme', 'link', form({ email: 'x@example.com' })))).toBe(
        '/acme/verify-email/confirm?resend=sent',
      );
      vi.restoreAllMocks();
    }
  });

  it('says so when the request was throttled or the service is down', async () => {
    apiAnswers(429, { error: { code: 'RATE_LIMITED', retryAfterSeconds: 600 } });
    expect(await redirectOf(() => resendVerificationAction('acme', 'login', form({ email: 'a@example.com' })))).toBe(
      '/acme/login?resend_error=RATE_LIMITED&retry=600',
    );
    apiAnswers(503, { error: { code: 'DEPENDENCY_UNAVAILABLE' } });
    expect(await redirectOf(() => resendVerificationAction('acme', 'link', form({ email: 'a@example.com' })))).toBe(
      '/acme/verify-email/confirm?resend_error=DEPENDENCY_UNAVAILABLE',
    );
  });
});

describe('the confirmation link landing route', () => {
  it('moves the token into a short-lived httpOnly cookie and redirects to a token-free page', async () => {
    const res = await landWithLink();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/acme/verify-email/confirm');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain(`${session.VERIFY_EMAIL_LINK}=${TOKEN}`);
    expect(set).toMatch(/Path=\/acme/);
    expect(set).toMatch(/HttpOnly/i);
  });

  it('spends nothing on a GET, so a mail scanner fetching the link cannot burn it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await landWithLink();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is reached as is with a stale session, so the token never goes round the refresh route', () => {
    const headers = { cookie: 'rekey_portal_refresh=rt', 'sec-fetch-dest': 'document' };
    const landing = new NextRequest(`https://portal.example/acme/verify-email?token=${TOKEN}`, { headers });
    expect(middleware(landing).headers.get('location')).toBeNull();
    const page = new NextRequest('https://portal.example/acme', { headers });
    expect(middleware(page).headers.get('location')).toContain('/acme/session/refresh');
  });
});

describe('confirming with the link', () => {
  it('spends the token, clears the cookie and shows the confirmed state', async () => {
    await landWithLink();
    const fetchSpy = apiAnswers(200, { success: true, data: { ok: true, endUser: {} } });
    expect(await redirectOf(() => confirmEmailAction('acme'))).toBe('/acme/verify-email/confirm?done=1');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/v1/auth/verify-email');
    expect(JSON.parse(String(init!.body))).toEqual({ token: TOKEN });
    expect(jar.get(session.VERIFY_EMAIL_LINK)?.options.maxAge).toBe(0);
  });

  it('sends an expired or used link back with its code', async () => {
    for (const code of ['EMAIL_VERIFICATION_TOKEN_EXPIRED', 'EMAIL_VERIFICATION_TOKEN_USED']) {
      await landWithLink();
      apiAnswers(401, { error: { code } });
      expect(await redirectOf(() => confirmEmailAction('acme'))).toBe(`/acme/verify-email/confirm?error=${code}`);
      expect(jar.get(session.VERIFY_EMAIL_LINK)?.options.maxAge).toBe(0);
      vi.restoreAllMocks();
    }
  });

  it('with no link waiting, calls nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await redirectOf(() => confirmEmailAction('acme'))).toBe('/acme/verify-email/confirm');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
