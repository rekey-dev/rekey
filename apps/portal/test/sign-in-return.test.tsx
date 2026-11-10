/**
 * A sign-in started from the devices page or a plan's page lands back on it,
 * whichever way the customer signs in. The page is named by a keyword
 * (`devices`, `plan:<planSlug>`); any other value of `?return=` is ignored and
 * sign-in lands on the dashboard.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactNode } from 'react';
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

const state = { signedIn: false };
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({
    name: 'Acme',
    publishableKey: 'pk_test',
    billingSubject: 'user',
    billingEnabled: true,
    branding: {},
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

const client = { signIn: vi.fn(), mfaVerify: vi.fn(), verifyMagicLink: vi.fn() };
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  portalClientFor: async () => client,
  getPortalUser: async () => (state.signedIn ? { accessToken: 'at', user: { email: 'a@example.com' } } : null),
}));

const session = await import('@/lib/session');
const { signInAction, mfaVerifyAction, requestSignInLinkAction, signInWithLinkAction } = await import('@/lib/actions');
const { GET: signInLinkLanding } = await import('@/app/(portal)/[slug]/sign-in-link/route');
const { default: LoginPage } = await import('@/app/(portal)/[slug]/login/page');
const { default: SetUpPage } = await import('@/app/(portal)/[slug]/two-factor/set-up/page');
const { default: PlanReviewPage } = await import('@/app/(portal)/[slug]/plans/[planSlug]/page');

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

function signInWithPassword(returnTo?: string): Promise<string> {
  const fields: Record<string, string> = { email: 'a@example.com', password: 'pw' };
  if (returnTo !== undefined) fields.return = returnTo;
  return redirectOf(() => signInAction('acme', form(fields)));
}

/** The first `continueHref` prop anywhere in a rendered element tree. */
function continueHrefIn(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return Array.isArray(node) ? node.map(continueHrefIn).find(Boolean) : undefined;
  const props = node.props as { continueHref?: string; children?: ReactNode };
  return props.continueHref ?? continueHrefIn(props.children);
}

beforeEach(() => {
  jar.clear();
  state.signedIn = false;
  client.signIn.mockReset();
  client.mfaVerify.mockReset();
  client.verifyMagicLink.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('returning to the devices page after sign-in', () => {
  it('password sign-in lands on the devices page and forgets the request', async () => {
    client.signIn.mockResolvedValueOnce(SESSION);
    expect(await signInWithPassword('devices')).toBe('/acme/devices');
    expect(jar.get(session.SIGN_IN_RETURN)?.options).toMatchObject({ maxAge: 0 });
    client.signIn.mockResolvedValueOnce(SESSION);
    expect(await signInWithPassword()).toBe('/acme');
  });

  it('is remembered in a short httpOnly cookie scoped to the application', async () => {
    client.signIn.mockResolvedValueOnce({ mfaRequired: true, mfaChallengeToken: 'challenge' });
    await signInWithPassword('devices');
    expect(jar.get(session.SIGN_IN_RETURN)).toEqual({
      value: 'devices',
      options: expect.objectContaining({ httpOnly: true, path: '/acme', maxAge: 15 * 60 }),
    });
  });

  it('survives a mistyped password and the two-factor code step', async () => {
    client.signIn.mockRejectedValueOnce(new RekeyError({ statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'no' } as never));
    expect(await signInWithPassword('devices')).toMatch(/^\/acme\/login\?error=INVALID_CREDENTIALS/);
    client.signIn.mockResolvedValueOnce({ mfaRequired: true, mfaChallengeToken: 'challenge' });
    expect(await signInWithPassword()).toBe('/acme/login?step=mfa');
    client.mfaVerify.mockResolvedValueOnce(SESSION);
    expect(await redirectOf(() => mfaVerifyAction('acme', form({ code: '123456' })))).toBe('/acme/devices');
  });

  it('survives an emailed sign-in link, from the request to the landing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { success: true, data: { sent: true } }));
    const sent = await redirectOf(() => requestSignInLinkAction('acme', form({ email: 'a@example.com', return: 'devices' })));
    expect(sent).toBe('/acme/login?link=sent');
    const landing = await signInLinkLanding(new NextRequest('https://portal.example/acme/sign-in-link?token=ml_token'), {
      params: Promise.resolve({ slug: 'acme' }),
    });
    const link = landing.headers.get('set-cookie') ?? '';
    expect(link).toContain(`${session.SIGN_IN_LINK}=ml_token`);
    jar.set(session.SIGN_IN_LINK, { value: 'ml_token', options: { maxAge: 900 } });
    client.verifyMagicLink.mockResolvedValueOnce(SESSION);
    expect(await redirectOf(() => signInWithLinkAction('acme'))).toBe('/acme/devices');
  });

  it('survives required two-factor setup', async () => {
    client.signIn.mockResolvedValueOnce({ ...SESSION, mfaEnrollmentRequired: true });
    expect(await signInWithPassword('devices')).toBe('/acme/two-factor/set-up');
    state.signedIn = true;
    const enrolled = { enabled: false, remainingBackupCodes: null, policy: 'required' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json(200, { success: true, data: enrolled }));
    expect(continueHrefIn(await SetUpPage({ params: Promise.resolve({ slug: 'acme' }) }))).toBe('/acme/devices');
    enrolled.enabled = true;
    expect(await redirectOf(() => SetUpPage({ params: Promise.resolve({ slug: 'acme' }) }))).toBe('/acme/devices');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('carries the keyword through the sign-in forms, and an already signed-in visitor goes straight there', async () => {
    const html = renderToStaticMarkup(
      await LoginPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve({ return: 'devices' }) }),
    );
    expect(html.match(/<input type="hidden" name="return" value="devices"\/>/g)).toHaveLength(2);
    state.signedIn = true;
    expect(
      await redirectOf(() =>
        LoginPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve({ return: 'devices' }) }),
      ),
    ).toBe('/acme/devices');
  });
});

describe('any other return value', () => {
  it.each([
    '//evil.com',
    '/other',
    'devices/../x',
    '/acme/devices',
    'Devices',
    '',
    'plan:',
    'plan:Pro',
    'plan:-pro',
    'plan:pro-',
    'plan:../devices',
    'plan:pro/../../x',
    'plan://evil.com',
    'plan:/acme/devices',
    'plan:pro?x=1',
    'plan:pro#x',
    'plan:pro%2F..',
    'plan:pro\n',
    'plan:pro\\evil',
    ' plan:pro',
    'PLAN:pro',
    'plans:pro',
    `plan:${'a'.repeat(41)}`,
    'https://evil.com/plan:pro',
  ])(
    'ignores %j and lands on the dashboard',
    async (value) => {
      client.signIn.mockResolvedValueOnce(SESSION);
      expect(await signInWithPassword(value)).toBe('/acme');
      expect(jar.has(session.SIGN_IN_RETURN)).toBe(false);
      const html = renderToStaticMarkup(
        await LoginPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve({ return: value }) }),
      );
      expect(html).not.toContain('name="return"');
    },
  );
});

describe("returning to a plan's page after sign-in", () => {
  it('sends a signed-out visit to a plan page through sign-in and back to that plan', async () => {
    const login = await redirectOf(() =>
      PlanReviewPage({ params: Promise.resolve({ slug: 'acme', planSlug: 'pro_yearly' }), searchParams: Promise.resolve({}) }),
    );
    expect(login).toBe('/acme/login?return=plan%3Apro_yearly');
    const html = renderToStaticMarkup(
      await LoginPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve({ return: 'plan:pro_yearly' }) }),
    );
    expect(html).toContain('<input type="hidden" name="return" value="plan:pro_yearly"/>');
    client.signIn.mockResolvedValueOnce({ mfaRequired: true, mfaChallengeToken: 'challenge' });
    expect(await signInWithPassword('plan:pro_yearly')).toBe('/acme/login?step=mfa');
    client.mfaVerify.mockResolvedValueOnce(SESSION);
    expect(await redirectOf(() => mfaVerifyAction('acme', form({ code: '123456' })))).toBe('/acme/plans/pro_yearly');
  });

  it('signs a visit to a plan slug the API could not have issued in to the dashboard', async () => {
    const login = await redirectOf(() =>
      PlanReviewPage({ params: Promise.resolve({ slug: 'acme', planSlug: '..%2F..%2Fevil' }), searchParams: Promise.resolve({}) }),
    );
    expect(login).toBe('/acme/login');
  });

  it('accepts the longest slug the API allows', async () => {
    client.signIn.mockResolvedValueOnce(SESSION);
    expect(await signInWithPassword(`plan:${'a'.repeat(40)}`)).toBe(`/acme/plans/${'a'.repeat(40)}`);
  });
});
