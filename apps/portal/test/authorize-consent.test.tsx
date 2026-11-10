/**
 * The portal as an Application's authorization page: the request survives
 * every way of signing in, the consent screen shows what the customer must
 * judge, Allow and Cancel answer through the API, and the code never sits in
 * a portal URL.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
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

const state = { signedIn: false };
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({
    slug: 'acme',
    name: 'Acme',
    publishableKey: 'pk_test',
    billingSubject: 'user',
    billingEnabled: true,
    branding: { displayName: 'Acme Tools' },
    auth: { password: true, magicLink: true, mfaRequired: true },
  }),
}));
vi.mock('@/lib/env', () => ({
  portalBaseUrl: () => 'https://portal.example',
  rekeyApiUrl: () => 'https://api.example',
}));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({ 'x-rekey-caller-secret': 'portal-secret', origin: 'https://portal.example' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
}));

const client = { signIn: vi.fn(), mfaVerify: vi.fn(), verifyMagicLink: vi.fn(), signOut: vi.fn() };
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  portalClientFor: async () => client,
  getPortalUser: async () => (state.signedIn ? { accessToken: 'at', user: { email: 'ada@example.com' } } : null),
}));

const session = await import('@/lib/session');
const { signInAction, mfaVerifyAction, signInWithLinkAction } = await import('@/lib/actions');
const { signInReturnPage, afterSignInPath } = await import('@/lib/sign-in-return');
const { allowAuthorizationAction, cancelAuthorizationAction, switchAccountAction } = await import('@/lib/authorize-actions');
const { AUTHORIZE_DONE } = await import('@/lib/authorize-request');
const { GET: authorizeLanding } = await import('@/app/(portal)/[slug]/authorize/route');
const { default: ConsentPage } = await import('@/app/(portal)/[slug]/authorize/consent/page');
const { default: DonePage } = await import('@/app/(portal)/[slug]/authorize/done/page');
const { default: SetUpPage } = await import('@/app/(portal)/[slug]/two-factor/set-up/page');

const ID = 'Abc_def-0123456789abcdefghijklmnopqrstuvwxy';
const BACK = `/acme/authorize/consent?request=${ID}`;
const SESSION = { mfaRequired: false, accessToken: 'at2', refreshToken: 'rt2' };

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const PREVIEW = {
  client_id: 'cid',
  client_name: 'Desk Client',
  redirect_uri: 'http://127.0.0.1:53682/callback',
  scope: 'openid email weird:scope',
  account: { email: 'ada@example.com' },
  organizations: [],
};

async function consent(sp: Record<string, string> = { request: ID }): Promise<string> {
  return renderToStaticMarkup(
    await ConsentPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(sp) }),
  );
}

/** The props of the first element in a tree that has `prop`. */
function propsWith<T>(node: ReactNode, prop: string): T | undefined {
  if (!isValidElement(node)) return Array.isArray(node) ? node.map((n) => propsWith<T>(n, prop)).find(Boolean) : undefined;
  const props = (node as ReactElement).props as Record<string, unknown> & { children?: ReactNode };
  return prop in props ? (props as T) : propsWith<T>(props.children, prop);
}

beforeEach(() => {
  jar.clear();
  state.signedIn = false;
  for (const fn of Object.values(client)) fn.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('the return keyword', () => {
  it('accepts only an id of the exact shape the API issues', () => {
    expect(signInReturnPage(`authorize:${ID}`)).toBe(`authorize:${ID}`);
    expect(afterSignInPath('acme', `authorize:${ID}`)).toBe(BACK);
    for (const bad of [
      `authorize:${ID.slice(1)}`,
      `authorize:${ID}x`,
      `authorize:${ID.slice(1)}/`,
      `authorize:${ID.slice(1)}.`,
      `authorize:${ID.slice(2)}//`,
      'authorize:',
      `Authorize:${ID}`,
      `authorize:${ID}\n`,
      `https://evil.example/authorize:${ID}`,
    ]) {
      expect(signInReturnPage(bad)).toBeNull();
    }
  });

  it('is remembered by the landing route in the httpOnly cookie, and an unknown id is not', async () => {
    const res = await authorizeLanding(new NextRequest(`https://portal.example/acme/authorize?request=${ID}`), {
      params: Promise.resolve({ slug: 'acme' }),
    });
    expect(res.headers.get('location')).toBe(`/acme/authorize/consent?request=${ID}`);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${session.SIGN_IN_RETURN}=authorize%3A${ID}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toContain('Path=/acme');

    const bad = await authorizeLanding(new NextRequest('https://portal.example/acme/authorize?request=../../x'), {
      params: Promise.resolve({ slug: 'acme' }),
    });
    expect(bad.headers.get('location')).toBe('/acme/authorize/consent');
    expect(bad.headers.get('set-cookie')).toBeNull();
  });

  it('survives password sign-in and the two-factor code step', async () => {
    client.signIn.mockResolvedValueOnce({ mfaRequired: true, mfaChallengeToken: 'challenge' });
    expect(await redirectOf(() => signInAction('acme', form({ email: 'a@x.co', password: 'pw', return: `authorize:${ID}` })))).toBe(
      '/acme/login?step=mfa',
    );
    client.mfaVerify.mockResolvedValueOnce(SESSION);
    expect(await redirectOf(() => mfaVerifyAction('acme', form({ code: '123456' })))).toBe(BACK);
  });

  it('survives an emailed sign-in link', async () => {
    jar.set(session.SIGN_IN_RETURN, { value: `authorize:${ID}`, options: { maxAge: 900 } });
    jar.set(session.SIGN_IN_LINK, { value: 'ml_token', options: { maxAge: 900 } });
    client.verifyMagicLink.mockResolvedValueOnce(SESSION);
    expect(await redirectOf(() => signInWithLinkAction('acme'))).toBe(BACK);
  });

  it('survives required two-factor setup', async () => {
    client.signIn.mockResolvedValueOnce({ ...SESSION, mfaEnrollmentRequired: true });
    expect(await redirectOf(() => signInAction('acme', form({ email: 'a@x.co', password: 'pw', return: `authorize:${ID}` })))).toBe(
      '/acme/two-factor/set-up',
    );
    state.signedIn = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json(200, { success: true, data: { enabled: false, remainingBackupCodes: null, policy: 'required' } }),
    );
    const page = await SetUpPage({ params: Promise.resolve({ slug: 'acme' }) });
    expect(propsWith<{ continueHref: string }>(page, 'continueHref')?.continueHref).toBe(BACK);
  });

  it('survives an email confirmation in between, when the next sign-in form carries nothing', async () => {
    client.signIn.mockRejectedValueOnce(
      Object.assign(new (await import('@rekey.dev/react')).RekeyError({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED', message: 'no' } as never)),
    );
    expect(
      await redirectOf(() => signInAction('acme', form({ email: 'a@x.co', password: 'pw', return: `authorize:${ID}` }))),
    ).toMatch(/error=EMAIL_NOT_VERIFIED/);
    client.signIn.mockResolvedValueOnce(SESSION);
    expect(await redirectOf(() => signInAction('acme', form({ email: 'a@x.co', password: 'pw' })))).toBe(BACK);
  });
});

describe('the consent screen', () => {
  it('sends a signed-out visitor to sign in, coming back to this request', async () => {
    expect(await redirectOf(() => consent())).toBe(`/acme/login?return=authorize%3A${ID}`);
  });

  it('shows the app, the client as a label, the destination, the scopes and the account', async () => {
    state.signedIn = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, PREVIEW));
    const html = await consent();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Allow access to your Acme Tools account?');
    expect(html).toContain('App requesting access');
    expect(html).toContain('Desk Client');
    expect(html).toContain('127.0.0.1:53682');
    expect(html).toContain('program on this computer');
    expect(html).toContain('Know which account is yours');
    expect(html).toContain('See your email address');
    expect(html).toContain('<code class="font-mono">weird:scope</code>');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Not you? Use a different account');
    expect(html.match(/>Allow</g)).toHaveLength(1);
    expect(html.match(/>Cancel</g)).toHaveLength(1);
    expect(html).not.toContain('autofocus');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example/api/v1/mcp/acme/oauth/authorize/preview');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ request_id: ID });
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer pk_test',
      'X-Rekey-User-Token': 'at',
      'x-rekey-caller-secret': 'portal-secret',
    });
  });

  it('escapes a client name and cuts a long one short', async () => {
    state.signedIn = true;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { ...PREVIEW, client_name: '<script>alert(1)</script>' }));
    const html = await consent();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { ...PREVIEW, client_name: 'N'.repeat(300) }));
    const long = await consent();
    expect(long).not.toContain('N'.repeat(61));
    expect(long).toContain(`${'N'.repeat(60)}…`);
  });

  it('names an app scheme with its scheme, and a web address by its host', async () => {
    state.signedIn = true;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { ...PREVIEW, redirect_uri: 'deskapp://callback/x' }));
    expect(await consent()).toContain('deskapp://callback');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { ...PREVIEW, redirect_uri: 'https://evil.example/cb' }));
    expect(await consent()).toContain('evil.example');
  });

  it('on a device-bound application, explains and offers only going back, which denies', async () => {
    state.signedIn = true;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json(403, { error: { code: 'AUTHORIZATION_NEEDS_DEVICE_SESSION', details: { client_name: 'Desk Client' } } }),
    );
    const page = await ConsentPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve({ request: ID }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('Acme Tools signs in from the app itself, so it cannot approve Desk Client here.');
    expect(html).toContain('Go back to Desk Client');
    expect(html).not.toContain('>Allow<');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/<form/g)).toHaveLength(1);

    jar.set(session.SIGN_IN_RETURN, { value: `authorize:${ID}`, options: { maxAge: 900 } });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { redirect_to: 'deskapp://callback?error=access_denied&state=s' }));
    const goBack = propsWith<{ action: () => Promise<void> }>(page, 'action')!.action;
    expect(await redirectOf(() => goBack())).toBe('/acme/authorize/done');
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/oauth\/authorize\/deny$/);
  });

  it('says an expired or unknown request is over and to start again from the app', async () => {
    expect(await consent({ request: 'nope' })).toContain('This sign-in request has expired');
    state.signedIn = true;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(400, { error: { code: 'AUTHORIZATION_REQUEST_UNKNOWN' } }));
    const html = await consent();
    expect(html).toContain('This sign-in request has expired');
    expect(html).toContain('Go back to the app that sent you here');
  });
});

describe('Allow and Cancel', () => {
  beforeEach(() => {
    jar.set(session.ACCESS, { value: 'at', options: { maxAge: 900 } });
    jar.set(session.SIGN_IN_RETURN, { value: `authorize:${ID}`, options: { maxAge: 900 } });
  });

  it('Allow grants this request and leaves a web redirect to the browser directly', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { redirect_to: 'https://app.example/cb?code=c0de&state=s', expires_in: 60 }));
    const to = await redirectOf(() => allowAuthorizationAction('acme', ID, 'Desk Client', form({})));
    expect(to).toBe('https://app.example/cb?code=c0de&state=s');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/oauth\/authorize\/grant$/);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ request_id: ID });
    expect(jar.get(session.SIGN_IN_RETURN)?.options.maxAge).toBe(0);
  });

  it('Allow for an app on this computer goes through the done page, with the code in a cookie and no URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json(200, { redirect_to: 'http://127.0.0.1:53682/callback?code=c0de&state=s', expires_in: 60 }),
    );
    const to = await redirectOf(() =>
      allowAuthorizationAction('acme', ID, 'Desk Client', form({ organization: 'personal' })),
    );
    expect(to).toBe('/acme/authorize/done');
    expect(to).not.toContain('c0de');
    const done = jar.get(AUTHORIZE_DONE)!;
    expect(done.options).toMatchObject({ httpOnly: true, path: '/acme', maxAge: 60 });
    expect(JSON.parse(done.value)).toEqual({
      target: 'http://127.0.0.1:53682/callback?code=c0de&state=s',
      client: 'Desk Client',
      outcome: 'allowed',
    });
  });

  it('Allow passes a chosen organization and shows a refusal on the consent page', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(403, { error: { code: 'ORGANIZATION_NOT_MEMBER' } }));
    const to = await redirectOf(() => allowAuthorizationAction('acme', ID, null, form({ organization: 'org_1' })));
    expect(to).toBe(`/acme/authorize/consent?request=${ID}&error=ORGANIZATION_NOT_MEMBER`);
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      request_id: ID,
      organization_id: 'org_1',
    });
  });

  it('Cancel denies this request and an app scheme goes through the done page', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { redirect_to: 'deskapp://callback?error=access_denied&state=s' }));
    expect(await redirectOf(() => cancelAuthorizationAction('acme', ID, 'Desk Client'))).toBe('/acme/authorize/done');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/oauth\/authorize\/deny$/);
    expect((init as RequestInit).headers).not.toHaveProperty('X-Rekey-User-Token');
    expect(JSON.parse(jar.get(AUTHORIZE_DONE)!.value).outcome).toBe('cancelled');
  });

  it('refuses an id that is not one the API issues, without calling it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await redirectOf(() => allowAuthorizationAction('acme', '../x', null, form({})))).toBe('/acme/authorize/consent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('"Not you?" signs out and comes back to this request', async () => {
    jar.set(session.REFRESH, { value: 'rt', options: { maxAge: 900 } });
    client.signOut.mockResolvedValueOnce(undefined);
    jar.delete(session.SIGN_IN_RETURN);
    expect(await redirectOf(() => switchAccountAction('acme', ID))).toBe(`/acme/login?return=authorize%3A${ID}`);
    expect(client.signOut).toHaveBeenCalledWith('rt');
    expect(jar.get(session.ACCESS)?.options.maxAge).toBe(0);
    expect(jar.get(session.SIGN_IN_RETURN)?.value).toBe(`authorize:${ID}`);
  });
});

describe('the done page', () => {
  it('shows the message and a link to the app, and clears its cookie', async () => {
    jar.set(AUTHORIZE_DONE, {
      value: JSON.stringify({ target: 'deskapp://callback?code=c0de', client: 'Desk Client', outcome: 'allowed' }),
      options: { maxAge: 60 },
    });
    const page = await DonePage({ params: Promise.resolve({ slug: 'acme' }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('>You can return to Desk Client and close this tab.<');
    expect(html.match(/You are signed in/g)).toHaveLength(1);
    expect(html).toContain('href="deskapp://callback?code=c0de"');
    expect(html).toContain('Open Desk Client');
    expect(html.match(/<h1/g)).toHaveLength(1);
    await propsWith<{ forget: () => Promise<void> }>(page, 'forget')!.forget();
    expect(jar.get(AUTHORIZE_DONE)?.options.maxAge).toBe(0);
  });

  it('never links to a script target, whatever the cookie says', async () => {
    jar.set(AUTHORIZE_DONE, {
      value: JSON.stringify({ target: 'javascript:alert(1)', client: 'x', outcome: 'allowed' }),
      options: { maxAge: 60 },
    });
    const html = renderToStaticMarkup(await DonePage({ params: Promise.resolve({ slug: 'acme' }) }));
    expect(html).not.toContain('javascript:');
    expect(html).toContain('This sign-in has finished');
  });
});
