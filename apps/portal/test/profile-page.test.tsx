/**
 * The profile page: answer the application's profile questions, see the email
 * address, and delete the account.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileField } from '@rekey.dev/shared-types';

const state = { signedIn: true, hasPassword: true, auth: { password: true, magicLink: false } as Record<string, boolean> };
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
    branding: { displayName: 'Acme Desktop', supportEmail: 'help@acme.example' },
    auth: state.auth,
  }),
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
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

const { default: ProfilePage } = await import('@/app/(portal)/[slug]/profile/page');
const { ProfileFields } = await import('@/components/profile-fields');
const { deleteAccountAction, saveProfileAction, sendDeleteCodeAction } = await import('@/lib/profile-actions');

const field = (f: Partial<ProfileField> & Pick<ProfileField, 'key' | 'label' | 'type'>): ProfileField => ({
  requiredForOnboarding: false,
  writableBy: 'user',
  showInList: false,
  pii: false,
  ...f,
});
const FIELDS = [
  field({ key: 'company', label: 'Company', type: 'text' }),
  field({ key: 'team_size', label: 'Team size', type: 'select', options: ['1', '2-10', '11+'] }),
  field({ key: 'seats', label: 'Seats', type: 'number' }),
  field({ key: 'newsletter', label: 'Newsletter', type: 'boolean' }),
  field({ key: 'site', label: 'Website', type: 'url' }),
  field({ key: 'birthday', label: 'Birthday', type: 'date' }),
];
const ME = { email: 'a@example.com', emailVerified: true, profile: { company: 'Acme', seats: 3 } };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
const ok = (data: unknown) => json(200, { success: true, data });
const refusal = (status: number, code: string) => json(status, { success: false, error: { code } });

type Route = (init: RequestInit | undefined) => Response;
function api(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    'GET /api/v1/users/me': () => ok(ME),
    'GET /api/v1/profile-schema': () => ok({ fields: FIELDS }),
    'GET /api/v1/auth/mfa/status': () => ok({ enabled: false, remainingBackupCodes: null, policy: 'optional' }),
    ...overrides,
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!route) throw new Error(`unexpected call to ${init?.method} ${url.pathname}`);
    return route(init);
  });
}

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await ProfilePage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) });
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
const IDLE = { status: 'idle' as const, message: '', errors: {}, draft: null };

beforeEach(() => {
  state.signedIn = true;
  state.hasPassword = true;
  state.auth = { password: true, magicLink: false };
  cookieWrites.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('the profile page', () => {
  it('sends a signed-out visitor to sign in', async () => {
    state.signedIn = false;
    expect(await redirectOf(() => render())).toBe('/acme/login');
  });

  it('shows the email address with a form to change it, under one heading', async () => {
    api();
    const html = await render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('a@example.com');
    expect(html).toMatch(/<input type="email"[^>]*name="newEmail"/);
    expect(html).toContain('Change email address');
  });

  it('says where the link went, and explains a refused change, from codes alone', async () => {
    api();
    expect(await render({ done: 'email_change_sent' })).toContain('Check the inbox of the new address');
    expect(await render({ email_error: 'EMAIL_CHANGE_SAME_ADDRESS' })).toContain('That is already your email address.');
  });

  it('hides the questions card when the application asks none', async () => {
    api({ 'GET /api/v1/profile-schema': () => ok({ fields: [] }) });
    expect(await render()).not.toContain('About you');
  });

  it('puts the delete account dialog behind a typed confirmation, asking for the authenticator code only with two-factor on', async () => {
    api();
    let html = await render();
    expect(html).toContain('Type DELETE to confirm');
    expect(html).toContain('name="password"');
    expect(html).not.toContain('name="code"');
    expect(html).toContain('is deleted straight away and this cannot be undone');
    vi.restoreAllMocks();
    api({ 'GET /api/v1/auth/mfa/status': () => ok({ enabled: true, remainingBackupCodes: 9, policy: 'optional' }) });
    html = await render();
    expect(html).toContain('name="code"');
    expect(html).not.toContain('name="emailCode"');
    expect(html).not.toContain('Email me a code');
  });

  it('asks an account with a password for it, and offers no emailed code', async () => {
    api();
    const html = await render();
    expect(html).toContain('name="password"');
    expect(html).not.toContain('Email me a code');
    expect(html).not.toContain('Never chose a password');
  });

  it('offers an emailed code to delete with when the account has no password and two-factor is off', async () => {
    state.hasPassword = false;
    api();
    let html = await render();
    expect(html).toContain('Email me a code');
    expect(html).toContain('The code from the email');
    expect(html).toContain('name="emailCode"');
    expect(html).not.toContain('name="password"');
    state.auth = { password: false, magicLink: true };
    html = await render();
    expect(html).not.toContain('name="password"');
    expect(html).toContain('The code from the email');
    expect(await render({ done: 'delete_code_sent' })).toContain('We emailed you a code.');
  });
});

describe('the profile fields', () => {
  it('renders each field type with a label tied to its input and an error tied to the field', () => {
    const html = renderToStaticMarkup(
      <ProfileFields fields={FIELDS} values={{ company: 'Acme', seats: '3' }} errors={{ site: 'Enter a web address.' }} />,
    );
    for (const f of FIELDS) expect(html).toMatch(new RegExp(`<label for="([^"]+)"[^>]*>${f.label}<[\\s\\S]*id="\\1"`));
    expect(html).toContain('type="number"');
    expect(html).toContain('type="url"');
    expect(html).toContain('type="date"');
    expect(html).toContain('<option value="2-10">2-10</option>');
    expect(html).toContain('<option value="true">Yes</option>');
    expect(html).toMatch(/aria-invalid="true" aria-describedby="([^"]+)"[\s\S]*id="\1"[^>]*>Enter a web address\./);
  });

  it('marks required fields only when asked to', () => {
    const required = [field({ key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true })];
    expect(renderToStaticMarkup(<ProfileFields fields={required} values={{}} />)).not.toContain('required');
    const firstRun = renderToStaticMarkup(<ProfileFields fields={required} values={{}} enforceRequired />);
    expect(firstRun).toContain('required=""');
    expect(firstRun).toContain('(required)');
  });

  it('asks a field of a type it does not know as plain text', () => {
    const html = renderToStaticMarkup(<ProfileFields fields={[field({ key: 'q', label: 'Q', type: 'colour' as never })]} values={{}} />);
    expect(html).toMatch(/<input[^>]*type="text"/);
  });
});

describe('saving the profile', () => {
  it('sends only the answers that changed, typed as the API stores them, and clears an emptied one', async () => {
    const spy = api({ 'PATCH /api/v1/users/me/profile': () => ok({ profile: {} }) });
    const result = await saveProfileAction(
      'acme',
      IDLE,
      form({
        'profile.company': '',
        'profile.team_size': '2-10',
        'profile.seats': '3',
        'profile.newsletter': 'true',
        'profile.site': '',
        'profile.birthday': '1990-02-28',
      }),
    );
    expect(result.status).toBe('saved');
    expect(result.message).toBe('Your profile was saved.');
    const patch = spy.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ company: null, team_size: '2-10', newsletter: true, birthday: '1990-02-28' });
  });

  it('names each refused answer next to its field and sends nothing', async () => {
    const spy = api();
    const result = await saveProfileAction(
      'acme',
      IDLE,
      form({ 'profile.seats': 'many', 'profile.site': 'ftp://x', 'profile.birthday': '2026-02-30', 'profile.team_size': '50' }),
    );
    expect(result.status).toBe('refused');
    expect(result.errors).toEqual({
      seats: 'Enter a number.',
      site: 'Enter a web address that starts with https:// or http://.',
      birthday: 'Enter a real date.',
      team_size: 'Choose one of the options.',
    });
    expect(result.draft?.seats).toBe('many');
    expect(spy.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('ignores a posted key the schema does not offer', async () => {
    const spy = api({ 'PATCH /api/v1/users/me/profile': () => ok({ profile: {} }) });
    await saveProfileAction('acme', IDLE, form({ 'profile.role': 'admin', 'profile.company': 'Acme Two', 'profile.seats': '3' }));
    const patch = spy.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ company: 'Acme Two' });
  });

  it('explains an API refusal', async () => {
    api({ 'PATCH /api/v1/users/me/profile': () => refusal(400, 'PROFILE_TOO_LARGE') });
    const result = await saveProfileAction('acme', IDLE, form({ 'profile.company': 'x', 'profile.seats': '3' }));
    expect(result).toMatchObject({ status: 'refused', message: 'Those answers are too long to save. Shorten some of them.' });
  });
});

describe('deleting the account', () => {
  it('refuses without the typed confirmation and calls nothing', async () => {
    const spy = api();
    expect(await redirectOf(() => deleteAccountAction('acme', form({ confirm: 'delete', password: 'pw-123' })))).toBe(
      '/acme/profile?error=confirm_mismatch',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('deletes with the password, signs out and says goodbye, with no password in any URL', async () => {
    const spy = api({ 'DELETE /api/v1/users/me': () => ok({ erased: true, erasedAt: '2026-11-10T00:00:00.000Z' }) });
    const to = await redirectOf(() => deleteAccountAction('acme', form({ confirm: 'DELETE', password: 'pw-123' })));
    expect(to).toBe('/acme/goodbye');
    expect(cookieWrites.some((c) => c.name === 'rekey_portal_access' && c.value === '')).toBe(true);
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ password: 'pw-123' });
  });

  it('asks the API to email a deletion code, with no code in the URL', async () => {
    const spy = api({ 'POST /api/v1/auth/email-code': () => ok({ sent: true, expiresAt: '2026-11-10T10:10:00.000Z' }) });
    expect(await redirectOf(() => sendDeleteCodeAction('acme'))).toBe('/acme/profile?done=delete_code_sent');
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ purpose: 'delete_account' });
    vi.restoreAllMocks();
    api({ 'POST /api/v1/auth/email-code': () => refusal(409, 'EMAIL_CODE_NOT_ACCEPTED') });
    expect(await redirectOf(() => sendDeleteCodeAction('acme'))).toBe('/acme/profile?error=EMAIL_CODE_NOT_ACCEPTED');
  });

  it('deletes with the emailed code in the body and none in any URL', async () => {
    const spy = api({ 'DELETE /api/v1/users/me': () => ok({ erased: true, erasedAt: '2026-11-10T00:00:00.000Z' }) });
    const to = await redirectOf(() => deleteAccountAction('acme', form({ confirm: 'DELETE', emailCode: '048 213' })));
    expect(to).toBe('/acme/goodbye');
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ emailCode: '048213' });
  });

  it.each([
    ['STEP_UP_REQUIRED', 401, 'That password or code was not right, so your account was not deleted.'],
    ['ACCOUNT_HAS_ACTIVE_SUBSCRIPTION', 409, 'You have a subscription that is still billing. Cancel it on the Overview page first'],
    ['ACCOUNT_SELF_DELETION_DISABLED', 403, 'Acme Desktop does not let accounts be deleted here.'],
    ['EMAIL_CODE_REQUIRED', 401, 'confirm the deletion with an emailed code'],
    ['EMAIL_CODE_INVALID', 401, 'That code is wrong or no longer works, so your account was not deleted.'],
  ])('explains %s and keeps the session', async (code, status, copy) => {
    api({ 'DELETE /api/v1/users/me': () => refusal(status, code) });
    const to = await redirectOf(() => deleteAccountAction('acme', form({ confirm: 'DELETE', password: 'pw-123' })));
    expect(to).toBe(`/acme/profile?error=${code}`);
    expect(to).not.toContain('pw-123');
    expect(cookieWrites).toEqual([]);
    expect(await render({ error: code })).toContain(copy);
  });
});
