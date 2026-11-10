/**
 * Changing the email address from the profile: asking mails a link to the new
 * address with no address in any redirect, the link lands on a route that
 * spends nothing, and its page confirms with the session or the password.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';

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
  getPortalConfig: async () => ({ slug: 'acme', name: 'Acme', publishableKey: 'pk_test', billingSubject: 'user', branding: {}, auth: {} }),
  PortalConfigUnavailableError: class extends Error {},
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({}),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
}));

const session = await import('@/lib/session');
const { requestEmailChangeAction, confirmEmailChangeAction } = await import('@/lib/email-change-actions');
const { GET } = await import('@/app/(portal)/[slug]/email-change-link/route');
const { default: ConfirmPage } = await import('@/app/(portal)/[slug]/profile/email/page');
const { middleware } = await import('@/middleware');

const TOKEN = 'ec_raw_token_value';

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

const apiAnswers = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

async function landWithLink(): Promise<Response> {
  const res = await GET(new NextRequest(`https://portal.example/acme/email-change-link?token=${TOKEN}`), {
    params: Promise.resolve({ slug: 'acme' }),
  });
  const value = new RegExp(`${session.EMAIL_CHANGE_LINK}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (value) jar.set(session.EMAIL_CHANGE_LINK, { value: decodeURIComponent(value), options: { maxAge: 3600 } });
  return res;
}

const signedIn = () => jar.set('rekey_portal_access', { value: 'at', options: { maxAge: 900 } });
const sessionCleared = () => jar.get('rekey_portal_access')?.options.maxAge === 0;

async function renderConfirm(searchParams: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await ConfirmPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) }),
  );
}

beforeEach(() => jar.clear());
afterEach(() => vi.restoreAllMocks());

describe('asking to change the address', () => {
  it('sends the new address and the portal landing to the API, and keeps the address out of the redirect', async () => {
    signedIn();
    const spy = apiAnswers(202, { success: true, data: { sent: true } });
    const to = await redirectOf(() => requestEmailChangeAction('acme', form({ newEmail: ' new@example.com ' })));
    expect(to).toBe('/acme/profile?done=email_change_sent');
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/v1/users/me/email');
    expect((init!.headers as Record<string, string>)['X-Rekey-User-Token']).toBe('at');
    expect(JSON.parse(String(init!.body))).toEqual({
      newEmail: 'new@example.com',
      confirmUrl: 'https://portal.example/acme/email-change-link?token={token}',
    });
  });

  it('names a refusal by its code only', async () => {
    signedIn();
    apiAnswers(403, { error: { code: 'EMAIL_CHANGE_DOMAIN_NOT_ALLOWED' } });
    const to = await redirectOf(() => requestEmailChangeAction('acme', form({ newEmail: 'x@blocked.example' })));
    expect(to).toBe('/acme/profile?email_error=EMAIL_CHANGE_DOMAIN_NOT_ALLOWED');
  });
});

describe('the email change link', () => {
  it('moves the token into a short-lived httpOnly cookie, spends nothing, and redirects to a token-free page', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await landWithLink();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/acme/profile/email');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain(`${session.EMAIL_CHANGE_LINK}=${TOKEN}`);
    expect(set).toMatch(/HttpOnly/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is reached as is with a stale session, so the token never goes round the refresh route', () => {
    const headers = { cookie: 'rekey_portal_refresh=rt', 'sec-fetch-dest': 'document' };
    const landing = new NextRequest(`https://portal.example/acme/email-change-link?token=${TOKEN}`, { headers });
    expect(middleware(landing).headers.get('location')).toBeNull();
  });
});

describe('confirming the change', () => {
  it('asks a signed-out visitor for the password, and a signed-in one only for the click', async () => {
    await landWithLink();
    expect(await renderConfirm()).toContain('name="password"');
    signedIn();
    expect(await renderConfirm()).not.toContain('name="password"');
  });

  it('confirms with the session, then signs out here and clears the link', async () => {
    await landWithLink();
    signedIn();
    const spy = apiAnswers(200, { success: true, data: { ok: true, email: 'new@example.com' } });
    expect(await redirectOf(() => confirmEmailChangeAction('acme', form({})))).toBe('/acme/profile/email?done=1');
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/v1/auth/email-change/confirm');
    expect((init!.headers as Record<string, string>)['X-Rekey-User-Token']).toBe('at');
    expect(JSON.parse(String(init!.body))).toEqual({ token: TOKEN });
    expect(sessionCleared()).toBe(true);
    expect(jar.get(session.EMAIL_CHANGE_LINK)?.options.maxAge).toBe(0);
    expect(await renderConfirm({ done: '1' })).toContain('Sign in with the new address.');
  });

  it('confirms with the password where nobody is signed in, keeping it out of the URL', async () => {
    await landWithLink();
    const spy = apiAnswers(200, { success: true, data: { ok: true, email: 'new@example.com' } });
    const to = await redirectOf(() => confirmEmailChangeAction('acme', form({ password: 'pw-secret-1' })));
    expect(to).toBe('/acme/profile/email?done=1');
    const [, init] = spy.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)['X-Rekey-User-Token']).toBeUndefined();
    expect(JSON.parse(String(init!.body))).toEqual({ token: TOKEN, password: 'pw-secret-1' });
  });

  it('keeps the link after a wrong password, and drops a dead one', async () => {
    await landWithLink();
    apiAnswers(401, { error: { code: 'INVALID_CREDENTIALS' } });
    const to = await redirectOf(() => confirmEmailChangeAction('acme', form({ password: 'wrong-one' })));
    expect(to).toBe('/acme/profile/email?error=INVALID_CREDENTIALS');
    expect(to).not.toContain('wrong-one');
    expect(jar.get(session.EMAIL_CHANGE_LINK)?.options.maxAge).toBe(3600);
    vi.restoreAllMocks();

    apiAnswers(401, { error: { code: 'EMAIL_CHANGE_TOKEN_INVALID' } });
    await redirectOf(() => confirmEmailChangeAction('acme', form({ password: 'pw' })));
    expect(jar.get(session.EMAIL_CHANGE_LINK)?.options.maxAge).toBe(0);
    expect(await renderConfirm({ error: 'EMAIL_CHANGE_TOKEN_INVALID' })).toContain('This link no longer works.');
  });

  it('says another account has the address', async () => {
    expect(await renderConfirm({ error: 'EMAIL_ALREADY_EXISTS' })).toContain('Another account already uses that address');
  });
});
