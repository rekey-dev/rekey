/**
 * The password reset pages exist only while the application allows password
 * sign-in. The emailed link lands on a route that moves its token into a
 * cookie, so the reset form's address never carries it.
 */

import { renderToStaticMarkup } from 'react-dom/server';
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

const state = { password: true };

vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({ name: 'Acme', publishableKey: 'pk_test', auth: { password: state.password }, branding: {} }),
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
const { forgotPasswordAction, resetPasswordAction } = await import('@/lib/actions');
const { default: ForgotPasswordPage } = await import('@/app/(portal)/[slug]/forgot-password/page');
const { default: ResetPasswordPage } = await import('@/app/(portal)/[slug]/reset-password/page');
const { GET: resetLinkLanding } = await import('@/app/(portal)/[slug]/reset-password-link/route');
const { middleware } = await import('@/middleware');

const PAGES = { 'forgot-password': ForgotPasswordPage, 'reset-password': ResetPasswordPage };
const TOKEN = 'pr_raw_token_value';

async function render(page: keyof typeof PAGES, searchParams: Record<string, string> = {}): Promise<string> {
  const element = await PAGES[page]({
    params: Promise.resolve({ slug: 'acme' }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
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

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function landWithLink(token = TOKEN): Promise<Response> {
  return resetLinkLanding(new NextRequest(`https://portal.example/acme/reset-password-link?token=${token}`), {
    params: Promise.resolve({ slug: 'acme' }),
  });
}

function holdLink(): void {
  jar.set(session.RESET_PASSWORD_LINK, { value: TOKEN, options: { maxAge: 3600 } });
}

beforeEach(() => {
  state.password = true;
  jar.clear();
  holdLink();
});
afterEach(() => vi.restoreAllMocks());

describe.each(Object.keys(PAGES) as (keyof typeof PAGES)[])('%s', (page) => {
  it('renders while password sign-in is on', async () => {
    expect(await render(page)).toContain('<form');
  });

  it('sends the customer to sign in when password sign-in is off', async () => {
    state.password = false;
    await expect(render(page)).rejects.toThrow('REDIRECT /acme/login');
  });

  it('says why when passwords were turned off after the page loaded', async () => {
    state.password = false;
    await expect(render(page, { error: 'AUTH_METHOD_DISABLED' })).rejects.toThrow('REDIRECT /acme/login?reason=password_off');
  });

  it('does not ask for a retry when the API refused because passwords are off', async () => {
    const html = await render(page, { error: 'AUTH_METHOD_DISABLED' });
    expect(html).toContain('Password sign-in is turned off for this account');
    expect(html).not.toContain('Try again');
  });
});

describe('the emailed reset link', () => {
  it('asks the API for a link to the landing route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect(await redirectOf(() => forgotPasswordAction('acme', form({ email: 'a@example.com' })))).toBe('/acme/forgot-password?sent=1');
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as { resetUrl: string };
    expect(body.resetUrl).toBe('https://portal.example/acme/reset-password-link?token={token}');
  });

  it('lands on a route that moves the token into a short httpOnly cookie and serves no page', async () => {
    const res = await landWithLink();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/acme/reset-password');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toContain(`${session.RESET_PASSWORD_LINK}=${TOKEN}`);
    expect(set).toMatch(/Path=\/acme/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Max-Age=3600/);
  });

  it('ignores an oversized token', async () => {
    expect((await landWithLink('x'.repeat(513))).headers.get('set-cookie')).toBeNull();
  });

  it('is reached as is with a stale session, so the token never goes round the refresh route', () => {
    const headers = { cookie: 'rekey_portal_refresh=rt', 'sec-fetch-dest': 'document' };
    const landing = new NextRequest(`https://portal.example/acme/reset-password-link?token=${TOKEN}`, { headers });
    expect(middleware(landing).headers.get('location')).toBeNull();
  });

  it('asks for the link again when no token is held', async () => {
    jar.clear();
    const html = await render('reset-password');
    expect(html).toContain('This page needs the link from your reset email');
    expect(html).not.toContain('name="newPassword"');
  });
});

describe('setting the new password', () => {
  it('states the rule under the field, tied to it, with a show-password toggle', async () => {
    const html = await render('reset-password');
    const input = /<input[^>]*name="newPassword"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('minLength="8"');
    const ruleId = /aria-describedby="([^"]+)"/.exec(input)?.[1];
    expect(html).toContain(`id="${ruleId}"`);
    expect(html).toMatch(new RegExp(`id="${ruleId}"[^>]*>At least 8 characters`));
    expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*>Show password<\/button>/);
    // The toggle sits inside the field, straight after the input, not under the rule.
    expect(html).toMatch(/<input[^>]*name="newPassword"[^>]*\/><button type="button" aria-pressed="false"/);
    expect(html).not.toContain(TOKEN);
  });

  it('spends the token from the cookie, never from the form, and clears it on success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const to = await redirectOf(() => resetPasswordAction('acme', form({ newPassword: 'a long password', token: 'forged' })));
    expect(to).toBe('/acme/login?reason=reset');
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ token: TOKEN, newPassword: 'a long password' });
    expect(jar.get(session.RESET_PASSWORD_LINK)?.options.maxAge).toBe(0);
  });

  it('keeps the token out of the address when the API refuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'PASSWORD_TOO_SHORT' } }), { status: 400 }),
    );
    const to = await redirectOf(() => resetPasswordAction('acme', form({ newPassword: 'short' })));
    expect(to).toBe('/acme/reset-password?error=PASSWORD_TOO_SHORT');
    expect(jar.get(session.RESET_PASSWORD_LINK)?.value).toBe(TOKEN);
  });
});
