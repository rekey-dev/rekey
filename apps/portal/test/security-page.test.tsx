/**
 * The security page: change the password, turn two-factor on or off, sign out
 * other sessions and remove a linked sign-in provider.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  signedIn: true,
  hasPassword: true,
  auth: { password: true, magicLink: false, devices: false } as Record<string, boolean>,
};
const cookieWrites: Array<{ name: string; value: string }> = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'rekey_portal_access' ? { name, value: 'at' } : undefined),
    set: (name: string, value: string) => cookieWrites.push({ name, value }),
  }),
  headers: async () => new Headers({ 'accept-language': 'en-IN,en;q=0.9' }),
}));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({
    slug: 'acme',
    name: 'Acme',
    publishableKey: 'pk_test',
    billingEnabled: true,
    billingSubject: 'user',
    branding: { displayName: 'Acme Desktop' },
    auth: state.auth,
  }),
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
vi.mock('@/lib/cookie-secure', () => ({ cookieSecure: async () => true }));
vi.mock('@/lib/two-factor', () => ({ redirectWhileTwoFactorOutstanding: async () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getPortalUser: async () =>
    state.signedIn ? { accessToken: 'at', user: { email: 'a@example.com', hasPassword: state.hasPassword } } : null,
}));

const { default: SecurityPage } = await import('@/app/(portal)/[slug]/security/page');
const actions = await import('@/lib/security-actions');
const { replaceBackupCodesAction } = await import('@/lib/two-factor-actions');

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SESSION = { id: 'rt_1', createdAt: '2026-11-03T10:00:00.000Z', expiresAt: '2026-12-03T10:00:00.000Z', userAgent: CHROME_MAC, ip: '203.0.113.9', deviceId: null, current: false };
const GOOGLE = { provider: 'google', providerAccountId: 'g1', email: 'a@gmail.example', createdAt: '2026-10-01T00:00:00.000Z' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
const ok = (data: unknown) => json(200, { success: true, data });
const refusal = (status: number, code: string) => json(status, { success: false, error: { code } });

type Route = (init: RequestInit | undefined) => Response;
function api(routes: Record<string, Route>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!route) throw new Error(`unexpected call to ${init?.method} ${url.pathname}`);
    return route(init);
  });
}
function pageApi(overrides: Record<string, Route> = {}) {
  return api({
    'GET /api/v1/auth/mfa/status': () => ok({ enabled: true, remainingBackupCodes: 7, policy: 'optional' }),
    'GET /api/v1/auth/sessions': () => ok({ items: [SESSION] }),
    'GET /api/v1/auth/oauth/identities': () => ok([GOOGLE]),
    ...overrides,
  });
}

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await SecurityPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) });
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
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const sessionCleared = () => cookieWrites.some((c) => c.name === 'rekey_portal_access' && c.value === '');

beforeEach(() => {
  state.signedIn = true;
  state.hasPassword = true;
  state.auth = { password: true, magicLink: false, devices: false };
  cookieWrites.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('the security page', () => {
  it('sends a signed-out visitor to sign in', async () => {
    state.signedIn = false;
    expect(await redirectOf(() => render())).toBe('/acme/login');
  });

  it('shows the password form, two-factor status, sessions and providers under one heading', async () => {
    pageApi();
    const html = await render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Current password');
    expect(html).toMatch(/<input[^>]*name="currentPassword"[^>]*\/><button type="button" aria-pressed="false" aria-label="Show current password"/);
    expect(html).toContain('At least 8 characters.');
    expect(html).toContain('Changing your password signs you out everywhere, here included.');
    expect(html).toContain('You have 7 backup codes left.');
    expect(html).toContain('aria-label="Turn off two-factor authentication"');
    expect(html).toContain('Chrome on macOS');
    expect(html).toContain('Last active 3 Nov 2026 · IP address 203.0.113.9');
    expect(html).toContain('aria-label="Sign out Chrome on macOS, last active 3 Nov 2026"');
    expect(html).toContain('a@gmail.example · Linked 1 Oct 2026');
    expect(html).toContain('aria-label="Remove Google"');
  });

  it('labels the session this browser is using, and warns that signing it out signs out here', async () => {
    pageApi({ 'GET /api/v1/auth/sessions': () => ok({ items: [{ ...SESSION, current: true }, { ...SESSION, id: 'rt_2' }] }) });
    const html = await render();
    expect(html.match(/This session/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Sign out of this session"');
    expect(html).toContain('This is the browser you are using now. You will be signed out here');
    expect(html).toContain('aria-label="Sign out Chrome on macOS, last active 3 Nov 2026"');
  });

  it('labels no session when none is this one', async () => {
    pageApi();
    expect(await render()).not.toContain('This session');
  });

  it('says two-factor cannot be turned off when the application requires it, and offers no button', async () => {
    pageApi({ 'GET /api/v1/auth/mfa/status': () => ok({ enabled: true, remainingBackupCodes: 10, policy: 'required' }) });
    const html = await render();
    expect(html).toContain('Acme Desktop requires two-factor authentication, so it cannot be turned off.');
    expect(html).not.toContain('Turn off two-factor');
  });

  it('offers set-up when two-factor is off, and hides the section when the application does not offer it', async () => {
    pageApi({ 'GET /api/v1/auth/mfa/status': () => ok({ enabled: false, remainingBackupCodes: null, policy: 'optional' }) });
    expect(await render()).toContain('Start setup');
    vi.restoreAllMocks();
    pageApi({ 'GET /api/v1/auth/mfa/status': () => ok({ enabled: false, remainingBackupCodes: null, policy: 'off' }) });
    expect(await render()).not.toContain('Two-factor authentication');
  });

  it('says the account signs in by link when the application has no password sign-in', async () => {
    state.auth = { password: false, magicLink: true, devices: false };
    pageApi();
    const html = await render();
    expect(html).not.toContain('Current password');
    expect(html).toContain('Acme Desktop signs you in with a link sent to your email address, so this account has no password to change.');
  });

  it('says what the sessions list is for when it is empty', async () => {
    pageApi({ 'GET /api/v1/auth/sessions': () => ok({ items: [] }) });
    expect(await render()).toContain('Each browser and app signed in to Acme Desktop appears here');
  });

  it('ignores a result it never sent', async () => {
    pageApi();
    expect(await render({ done: 'anything' })).not.toContain('aria-live="polite"');
    expect(await render({ done: 'session_revoked' })).toContain('That session was signed out.');
  });
});

describe('changing the password', () => {
  it('changes it, signs out here because the API ended every session, and keeps both passwords out of the URL', async () => {
    const spy = api({ 'POST /api/v1/auth/change-password': () => ok({ ok: true }) });
    const to = await redirectOf(() =>
      actions.changePasswordAction('acme', form({ currentPassword: 'old-secret-1', newPassword: 'new-secret-22' })),
    );
    expect(to).toBe('/acme/login?reason=reset');
    expect(to).not.toMatch(/secret/);
    expect(sessionCleared()).toBe(true);
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ currentPassword: 'old-secret-1', newPassword: 'new-secret-22' });
  });

  it('explains a wrong current password, pointing at the emailed link for accounts that never had one', async () => {
    api({ 'POST /api/v1/auth/change-password': () => refusal(401, 'INVALID_CREDENTIALS') });
    const to = await redirectOf(() =>
      actions.changePasswordAction('acme', form({ currentPassword: 'wrong-pass', newPassword: 'new-secret-22' })),
    );
    expect(to).toBe('/acme/security?error=INVALID_CREDENTIALS');
    expect(sessionCleared()).toBe(false);
    pageApi();
    expect(await render({ error: 'INVALID_CREDENTIALS' })).toContain('That is not your current password.');
  });

  it('explains a breached new password', async () => {
    api({ 'POST /api/v1/auth/change-password': () => refusal(400, 'PASSWORD_BREACHED') });
    expect(
      await redirectOf(() => actions.changePasswordAction('acme', form({ currentPassword: 'a', newPassword: 'password1' }))),
    ).toBe('/acme/security?error=PASSWORD_BREACHED');
    pageApi();
    expect(await render({ error: 'PASSWORD_BREACHED' })).toContain('appears in a known data breach');
  });

});

describe('change or create, by whether the account has a password', () => {
  it('offers only the change form to an account with a password, and only creation to one without', async () => {
    pageApi();
    let html = await render();
    expect(html).toContain('Current password');
    expect(html).not.toContain('Create a password');
    state.hasPassword = false;
    vi.restoreAllMocks();
    pageApi();
    html = await render();
    expect(html).not.toContain('Current password');
    expect(html).toContain('Create a password');
  });
});

describe('creating a first password', () => {
  beforeEach(() => {
    state.hasPassword = false;
  });

  it('asks the API to email a code, and says so without any code in the URL', async () => {
    const spy = api({ 'POST /api/v1/auth/email-code': () => ok({ sent: true, expiresAt: '2026-11-10T10:10:00.000Z' }) });
    expect(await redirectOf(() => actions.sendPasswordCodeAction('acme'))).toBe('/acme/security?done=password_code_sent');
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ purpose: 'set_password' });
    vi.restoreAllMocks();
    pageApi();
    const html = await render({ done: 'password_code_sent' });
    expect(html).toContain('We emailed you a code.');
    expect(html).toMatch(/<details open=""[^>]*>\s*<summary[^>]*>Create a password/);
  });

  it('keeps the form closed until it is needed, and offers no emailed reset link', async () => {
    pageApi();
    const html = await render();
    expect(html).toMatch(/<details class="[^"]*"><summary[^>]*>Create a password/);
    expect(html).not.toContain('Email me a link');
  });

  it('sets the password with the code, signs out here, and keeps both out of the URL', async () => {
    const spy = api({ 'POST /api/v1/auth/set-password': () => ok({ ok: true }) });
    const to = await redirectOf(() =>
      actions.setPasswordAction('acme', form({ emailCode: '048 213', newPassword: 'new-secret-22' })),
    );
    expect(to).toBe('/acme/login?reason=reset');
    expect(to).not.toMatch(/048|secret/);
    expect(sessionCleared()).toBe(true);
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ emailCode: '048213', newPassword: 'new-secret-22' });
  });

  it.each([
    ['EMAIL_CODE_INVALID', 401, 'That code is wrong or no longer works.'],
    ['PASSWORD_ALREADY_SET', 409, 'This account already has a password.'],
    ['PASSWORD_BREACHED', 400, 'appears in a known data breach'],
  ])('explains %s, reopens the form, and keeps the session', async (code, status, copy) => {
    api({ 'POST /api/v1/auth/set-password': () => refusal(status, code) });
    const to = await redirectOf(() => actions.setPasswordAction('acme', form({ emailCode: '048213', newPassword: 'new-secret-22' })));
    expect(to).toBe(`/acme/security?error=${code}`);
    expect(sessionCleared()).toBe(false);
    vi.restoreAllMocks();
    pageApi();
    const html = await render({ error: code });
    expect(html).toContain(copy);
    if (code !== 'PASSWORD_BREACHED') expect(html).toMatch(/<details open=""/);
  });

  it('asks for both fields without calling the API', async () => {
    const spy = api({});
    expect(await redirectOf(() => actions.setPasswordAction('acme', form({ emailCode: '', newPassword: 'x' })))).toBe(
      '/acme/security?error=missing_password_code',
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('turning two-factor off', () => {
  it('sends the code to the API and keeps it out of the URL', async () => {
    const spy = api({ 'POST /api/v1/auth/mfa/disable': () => ok({ disabled: true }) });
    const to = await redirectOf(() => actions.turnOffTwoFactorAction('acme', form({ code: '123 456' })));
    expect(to).toBe('/acme/security?done=two_factor_off');
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ code: '123456' });
  });

  it('explains a wrong code', async () => {
    api({ 'POST /api/v1/auth/mfa/disable': () => refusal(401, 'MFA_CODE_INVALID') });
    const to = await redirectOf(() => actions.turnOffTwoFactorAction('acme', form({ code: '000000' })));
    expect(to).toBe('/acme/security?error=MFA_CODE_INVALID');
    expect(to).not.toContain('000000');
  });
});

describe('getting new backup codes', () => {
  it('is offered only while two-factor is on', async () => {
    pageApi();
    expect(await render()).toContain('Get new backup codes');
    vi.restoreAllMocks();
    pageApi({ 'GET /api/v1/auth/mfa/status': () => ok({ enabled: false, remainingBackupCodes: null, policy: 'optional' }) });
    expect(await render()).not.toContain('Get new backup codes');
  });

  it('returns the new codes in the action response only, sending the authenticator code in the body', async () => {
    const codes = ['aaaa-1111', 'bbbb-2222'];
    const spy = api({ 'POST /api/v1/auth/mfa/backup-codes': () => json(201, { success: true, data: { backupCodes: codes } }) });
    expect(await replaceBackupCodesAction('acme', form({ code: '123 456' }))).toEqual({ ok: true, backupCodes: codes });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example/api/v1/auth/mfa/backup-codes');
    expect(JSON.parse(String(init!.body))).toEqual({ code: '123456' });
    expect(cookieWrites).toEqual([]);
  });

  it('explains a refused code without calling the API for an empty one', async () => {
    const spy = api({ 'POST /api/v1/auth/mfa/backup-codes': () => refusal(401, 'MFA_CODE_INVALID') });
    expect(await replaceBackupCodesAction('acme', form({ code: '' }))).toEqual({
      ok: false,
      message: 'Enter the 6-digit code from your authenticator app.',
    });
    expect(spy).not.toHaveBeenCalled();
    const refused = await replaceBackupCodesAction('acme', form({ code: 'abcd-1234' }));
    expect(refused).toEqual({ ok: false, message: expect.stringContaining('A backup code does not work here.') });
  });
});

describe('signing out sessions', () => {
  it('signs out another session and stays signed in here', async () => {
    api({ 'DELETE /api/v1/auth/sessions/rt_1': () => ok({ revoked: true }) });
    expect(await redirectOf(() => actions.revokeSessionAction('acme', 'rt_1', false))).toBe('/acme/security?done=session_revoked');
    expect(sessionCleared()).toBe(false);
  });

  it('signs the portal out cleanly when the session revoked was this one', async () => {
    const spy = api({ 'DELETE /api/v1/auth/sessions/rt_1': () => ok({ revoked: true }) });
    expect(await redirectOf(() => actions.revokeSessionAction('acme', 'rt_1', true))).toBe('/acme/login');
    expect(sessionCleared()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('signs out everywhere, here included', async () => {
    api({ 'POST /api/v1/auth/sign-out-everywhere': () => ok({ revokedCount: 3 }) });
    expect(await redirectOf(() => actions.signOutEverywhereAction('acme'))).toBe('/acme/login');
    expect(sessionCleared()).toBe(true);
  });
});

describe('removing a sign-in provider', () => {
  it('removes it', async () => {
    api({ 'DELETE /api/v1/auth/oauth/google': () => ok({ unlinked: true }) });
    expect(await redirectOf(() => actions.removeProviderAction('acme', 'google'))).toBe(
      '/acme/security?done=provider_removed',
    );
  });

  it('explains why the last way to sign in cannot be removed', async () => {
    api({ 'DELETE /api/v1/auth/oauth/google': () => refusal(409, 'OAUTH_UNLINK_WOULD_LOCK_OUT') });
    expect(await redirectOf(() => actions.removeProviderAction('acme', 'google'))).toBe(
      '/acme/security?error=OAUTH_UNLINK_WOULD_LOCK_OUT',
    );
    pageApi();
    expect(await render({ error: 'OAUTH_UNLINK_WOULD_LOCK_OUT' })).toContain(
      'That provider is the only way you can sign in, so it cannot be removed. Choose a password first, then remove it.',
    );
  });
});
