/**
 * The MFA challenge token rides in an httpOnly cookie, never in the URL.
 *
 * It used to travel as `/<slug>/login?mfa=<jwt>`, which put the whole signed
 * token in access logs and browser history. These tests drive the real server
 * actions against a fake cookie jar and a fake API client.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const client = {
  signIn: vi.fn(),
  mfaVerify: vi.fn(),
  signOut: vi.fn(async () => undefined),
};

vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ publishableKey: 'pk_test', billingSubject: 'user' }),
  PortalConfigUnavailableError: class extends Error {},
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
vi.mock('@/lib/client-ip', () => ({ API_TIMEOUT_MS: 1000, forwardedClientHeaders: async () => ({}) }));
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
const { signInAction, mfaVerifyAction, signOutAction } = await import('@/lib/actions');

const CHALLENGE = 'eyJhbGciOiJIUzI1NiJ9.challenge.sig';

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

const refusal = (code: string) => new RekeyError({ code, message: code, status: 401 } as never);
const session200 = { accessToken: 'at', refreshToken: 'rt' };
const challengeCookie = () => jar.get(session.MFA_CHALLENGE);

async function signInToMfaStep(): Promise<string> {
  client.signIn.mockResolvedValueOnce({ mfaRequired: true, mfaChallengeToken: CHALLENGE });
  return redirectOf(() => signInAction('acme', form({ email: 'a@example.com', password: 'pw' })));
}

describe('portal MFA challenge', () => {
  beforeEach(() => {
    jar.clear();
    client.signIn.mockReset();
    client.mfaVerify.mockReset();
  });

  it('keeps the challenge out of the URL and in a short-lived httpOnly cookie on the slug path', async () => {
    const to = await signInToMfaStep();
    expect(to).toBe('/acme/login?step=mfa');
    expect(to).not.toContain(CHALLENGE);
    expect(to).not.toMatch(/[?&]mfa=/);
    const cookie = challengeCookie();
    expect(cookie?.value).toBe(CHALLENGE);
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/acme',
      maxAge: 300,
    });
  });

  it.each([
    ['a TOTP code', '123456'],
    ['a backup code', 'abcde-fghij'],
  ])('completes sign-in with %s read from the cookie, then clears it', async (_label, code) => {
    await signInToMfaStep();
    client.mfaVerify.mockResolvedValueOnce(session200);
    const to = await redirectOf(() => mfaVerifyAction('acme', form({ code })));
    expect(to).toBe('/acme');
    expect(client.mfaVerify).toHaveBeenCalledWith({ mfaChallengeToken: CHALLENGE, code });
    expect(challengeCookie()?.options.maxAge).toBe(0);
    expect(jar.get(session.ACCESS)?.value).toBe('at');
  });

  it('ignores a challenge posted in the form: only the cookie counts', async () => {
    await signInToMfaStep();
    client.mfaVerify.mockResolvedValueOnce(session200);
    await redirectOf(() => mfaVerifyAction('acme', form({ code: '123456', challenge: 'forged' })));
    expect(client.mfaVerify).toHaveBeenCalledWith({ mfaChallengeToken: CHALLENGE, code: '123456' });
  });

  it('keeps the challenge after a wrong or spent code, without putting it in the URL', async () => {
    await signInToMfaStep();
    for (const code of ['MFA_CODE_INVALID', 'MFA_BACKUP_CODE_USED', 'MFA_CODE_REUSED']) {
      client.mfaVerify.mockRejectedValueOnce(refusal(code));
      const to = await redirectOf(() => mfaVerifyAction('acme', form({ code: '000000' })));
      expect(to).toBe(`/acme/login?step=mfa&error=${code}`);
      expect(challengeCookie()?.value).toBe(CHALLENGE);
    }
  });

  it('clears a dead challenge and sends the customer back to sign in', async () => {
    for (const code of ['MFA_CHALLENGE_INVALID', 'MFA_CHALLENGE_USED', 'MFA_CHALLENGE_WRONG_APPLICATION']) {
      await signInToMfaStep();
      client.mfaVerify.mockRejectedValueOnce(refusal(code));
      const to = await redirectOf(() => mfaVerifyAction('acme', form({ code: '123456' })));
      expect(to).toBe(`/acme/login?error=${code}`);
      expect(challengeCookie()?.options.maxAge).toBe(0);
    }
  });

  it('with no challenge cookie (expired or never set), goes back to sign in with a reason', async () => {
    const to = await redirectOf(() => mfaVerifyAction('acme', form({ code: '123456' })));
    expect(to).toBe('/acme/login?reason=mfa_expired');
    expect(client.mfaVerify).not.toHaveBeenCalled();
  });

  it('sign-out clears a pending challenge', async () => {
    await signInToMfaStep();
    await redirectOf(() => signOutAction('acme'));
    expect(challengeCookie()?.options.maxAge).toBe(0);
  });
});

describe('forgot password', () => {
  it('asks the API to put the reset token in the link the portal reads', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { forgotPasswordAction } = await import('@/lib/actions');
    const to = await redirectOf(() => forgotPasswordAction('acme', form({ email: 'a@example.com' })));
    expect(to).toBe('/acme/forgot-password?sent=1');
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as { resetUrl: string };
    expect(body.resetUrl).toBe('https://portal.example/acme/reset-password?token={token}');
    fetchSpy.mockRestore();
  });
});
