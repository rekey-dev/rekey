/**
 * Required two-factor setup: a sign-in that reports enrolment outstanding goes
 * to the setup page, the dashboard and plan pages send the customer back there
 * until the API says they are enrolled, and the setup key and backup codes only
 * ever travel in the action's own response.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const state = { mfaRequired: true };
vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({
    name: 'Acme',
    publishableKey: 'pk_test',
    billingSubject: 'user',
    billingEnabled: true,
    branding: {},
    auth: { mfaRequired: state.mfaRequired },
  }),
  supportLink: () => undefined,
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
  notFound: () => {
    throw new Error('NOT FOUND');
  },
}));

const client = { signIn: vi.fn() };
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  portalClientFor: async () => client,
  getPortalUser: async () => ({ accessToken: 'at', user: { email: 'a@example.com' } }),
}));

const session = await import('@/lib/session');
const { signInAction } = await import('@/lib/actions');
const { twoFactorSetUpOutstanding } = await import('@/lib/two-factor');
const { startTwoFactorSetUpAction, confirmTwoFactorSetUpAction } = await import('@/lib/two-factor-actions');
const { default: DashboardPage } = await import('@/app/(portal)/[slug]/(overview)/page');
const { default: PlanReviewPage } = await import('@/app/(portal)/[slug]/plans/[planSlug]/page');
const { default: SetUpPage } = await import('@/app/(portal)/[slug]/two-factor/set-up/page');

const SECRET = 'JBSWY3DPEHPK3PXP';
const OTPAUTH = `otpauth://totp/Rekey:a%40example.com?secret=${SECRET}&issuer=Rekey`;
const BACKUP_CODES = ['ab12c-de34f', 'gh56i-jk78l'];

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

/** The API, by path: MFA status says not enrolled under a required policy unless told otherwise. */
function api(answers: Record<string, () => Response> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const answer = answers[path];
    if (answer) return answer();
    if (path === '/api/v1/auth/mfa/status') {
      return json(200, { success: true, data: { enabled: false, remainingBackupCodes: null, policy: 'required' } });
    }
    throw new Error(`unexpected call to ${path}`);
  });
}

beforeEach(() => {
  jar.clear();
  client.signIn.mockReset();
  state.mfaRequired = true;
  jar.set(session.ACCESS, { value: 'at', options: { maxAge: 900 } });
});
afterEach(() => vi.restoreAllMocks());

describe('signing in when two-factor setup is required', () => {
  it('starts the session and goes to the setup page instead of the dashboard', async () => {
    client.signIn.mockResolvedValueOnce({ mfaRequired: false, mfaEnrollmentRequired: true, accessToken: 'at2', refreshToken: 'rt2' });
    const to = await redirectOf(() => signInAction('acme', form({ email: 'a@example.com', password: 'pw' })));
    expect(to).toBe('/acme/two-factor/set-up');
    expect(jar.get(session.ACCESS)?.value).toBe('at2');
  });

  it('goes to the dashboard when nothing is outstanding', async () => {
    client.signIn.mockResolvedValueOnce({ mfaRequired: false, accessToken: 'at2', refreshToken: 'rt2' });
    expect(await redirectOf(() => signInAction('acme', form({ email: 'a@example.com', password: 'pw' })))).toBe('/acme');
  });
});

describe('whether setup is outstanding', () => {
  it('asks the API with the customer token, and is outstanding until it reports enrolment', async () => {
    const fetchSpy = api();
    const config = { publishableKey: 'pk_test', auth: { mfaRequired: true } } as never;
    expect(await twoFactorSetUpOutstanding(config, 'at')).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/v1/auth/mfa/status');
    expect(new Headers(init!.headers).get('X-Rekey-User-Token')).toBe('at');
    vi.restoreAllMocks();
    api({
      '/api/v1/auth/mfa/status': () =>
        json(200, { success: true, data: { enabled: true, remainingBackupCodes: 10, policy: 'required' } }),
    });
    expect(await twoFactorSetUpOutstanding(config, 'at')).toBe(false);
  });

  it('asks nothing when the application does not require it', async () => {
    const fetchSpy = api();
    expect(await twoFactorSetUpOutstanding({ auth: { mfaRequired: false } } as never, 'at')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the dashboard and plan pages on the setup page while outstanding', async () => {
    api();
    const params = Promise.resolve({ slug: 'acme' });
    const searchParams = Promise.resolve({});
    expect(await redirectOf(() => DashboardPage({ params, searchParams }))).toBe('/acme/two-factor/set-up');
    expect(
      await redirectOf(() => PlanReviewPage({ params: Promise.resolve({ slug: 'acme', planSlug: 'pro' }), searchParams })),
    ).toBe('/acme/two-factor/set-up');
  });
});

describe('the setup page', () => {
  it('explains why under one heading, fetches no setup key on load and leaves the dashboard once enrolled', async () => {
    const fetchSpy = api();
    const html = renderToStaticMarkup(await SetUpPage({ params: Promise.resolve({ slug: 'acme' }) }));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Acme asks for a code from an authenticator app');
    expect(html).toContain('Start setup');
    expect(fetchSpy.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual(['/api/v1/auth/mfa/status']);
    vi.restoreAllMocks();
    api({
      '/api/v1/auth/mfa/status': () =>
        json(200, { success: true, data: { enabled: true, remainingBackupCodes: 10, policy: 'required' } }),
    });
    expect(await redirectOf(() => SetUpPage({ params: Promise.resolve({ slug: 'acme' }) }))).toBe('/acme');
  });
});

describe('the setup actions', () => {
  it('hand the setup key, QR code and backup codes back in the response, with no redirect and no log', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    api({
      '/api/v1/auth/mfa/setup': () =>
        json(201, { success: true, data: { otpauthUrl: OTPAUTH, backupCodes: BACKUP_CODES, warning: 'once' } }),
    });
    const result = await startTwoFactorSetUpAction('acme');
    expect(result).toMatchObject({ ok: true, setUp: { otpauthUrl: OTPAUTH, setupKey: SECRET, backupCodes: BACKUP_CODES } });
    expect(result.ok && result.setUp.qrSvg).toContain('<svg');
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it('confirms a code without redirecting, so the codes are shown from the same response', async () => {
    const fetchSpy = api({ '/api/v1/auth/mfa/setup-confirm': () => json(200, { success: true, data: { ok: true } }) });
    expect(await confirmTwoFactorSetUpAction('acme', form({ code: '123 456' }))).toEqual({ ok: true });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({ code: '123456' });
  });

  it('says a wrong code did not match and lets the customer try again', async () => {
    api({ '/api/v1/auth/mfa/setup-confirm': () => json(422, { error: { code: 'MFA_CODE_INVALID' } }) });
    const result = await confirmTwoFactorSetUpAction('acme', form({ code: '000000' }));
    expect(result).toEqual({ ok: false, message: expect.stringContaining('did not match') });
  });

  it('says the setup timed out when the session or the pending setup has expired', async () => {
    api({ '/api/v1/auth/mfa/setup-confirm': () => json(400, { error: { code: 'MFA_NOT_INITIATED' } }) });
    expect(await confirmTwoFactorSetUpAction('acme', form({ code: '123456' }))).toEqual({
      ok: false,
      message: expect.stringContaining('timed out'),
    });
    vi.restoreAllMocks();
    jar.clear();
    const fetchSpy = api();
    expect(await startTwoFactorSetUpAction('acme')).toEqual({ ok: false, message: expect.stringContaining('timed out') });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
