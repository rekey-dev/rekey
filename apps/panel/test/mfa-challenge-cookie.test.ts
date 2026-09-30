/**
 * The operator MFA challenge travels in an httpOnly cookie scoped to
 * /mfa-verify, never in a URL, and every way out of a sign-in drops it.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicPost = vi.fn();
const jar = new Map<string, string>();

vi.mock('@/lib/cookie-secure', () => ({ cookieSecure: async () => true }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, publicPost: (...args: unknown[]) => publicPost(...args) };
});

const { challengeMaxAge, mfaVerifyPath, MFA_CHALLENGE_COOKIE, MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS } =
  await import('@/lib/mfa-challenge');

function jwt(payload: Record<string, unknown>): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part(payload)}.sig`;
}

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const TOKEN = jwt({ sub: 'op_1', exp: NOW / 1000 + 300 });

function challengeCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${MFA_CHALLENGE_COOKIE}=`));
}

beforeEach(() => {
  publicPost.mockReset();
  jar.clear();
});

describe('challengeMaxAge', () => {
  it('ends the cookie when the token expires', () => {
    expect(challengeMaxAge(jwt({ exp: NOW / 1000 + 120 }), NOW)).toBe(120);
  });

  it('never outlives the API lifetime, and never goes to zero', () => {
    expect(challengeMaxAge(jwt({ exp: NOW / 1000 + 86_400 }), NOW)).toBe(MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS);
    expect(challengeMaxAge(jwt({ exp: NOW / 1000 - 10 }), NOW)).toBe(1);
  });

  it('falls back to the API lifetime for an unreadable token', () => {
    expect(challengeMaxAge('not-a-jwt', NOW)).toBe(MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS);
    expect(challengeMaxAge('a.%%%.c', NOW)).toBe(MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS);
    expect(challengeMaxAge(jwt({ exp: 'soon' }), NOW)).toBe(MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS);
  });
});

describe('mfaVerifyPath', () => {
  it('carries next and error, and nothing else', () => {
    expect(mfaVerifyPath({})).toBe('/mfa-verify');
    expect(mfaVerifyPath({ next: '/accept-invite?id=1', error: 'MFA_CODE_INVALID' })).toBe(
      '/mfa-verify?error=MFA_CODE_INVALID&next=%2Faccept-invite%3Fid%3D1',
    );
  });
});

describe('first-factor route handlers hand the challenge over in a cookie', () => {
  it('magic link: 303 to /mfa-verify with no token in the Location', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    publicPost.mockResolvedValue({ mfaRequired: true, mfaChallengeToken: TOKEN });
    const { GET } = await import('@/app/login/magic-link/route');
    const res = await GET(new NextRequest('http://panel.test/login/magic-link?token=ml_1'));
    vi.useRealTimers();

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/mfa-verify');
    const cookie = challengeCookie(res);
    expect(cookie).toContain(`${MFA_CHALLENGE_COOKIE}=${TOKEN}`);
    expect(cookie).toMatch(/Path=\/mfa-verify/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=300/);
  });

  it('cloud handoff: 303 to /mfa-verify with no token in the Location', async () => {
    publicPost.mockResolvedValue({ mfaRequired: true, mfaChallengeToken: TOKEN });
    const { POST } = await import('@/app/login/cloud/route');
    const body = new URLSearchParams({ id_token: 'idt' });
    const res = await POST(
      new NextRequest('http://panel.test/login/cloud', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(res.headers.get('location')).toBe('/mfa-verify');
    expect(challengeCookie(res)).toContain(`${MFA_CHALLENGE_COOKIE}=${TOKEN}`);
  });

  it('OAuth callback: keeps next, and the token stays out of the Location', async () => {
    jar.set('oauth_state', 's1');
    jar.set('oauth_provider', 'github');
    jar.set('oauth_next', '/accept-invite?id=inv_1');
    publicPost.mockResolvedValue({ mfaRequired: true, mfaChallengeToken: TOKEN });
    const { GET } = await import('@/app/login/oauth/[provider]/callback/route');
    const res = await GET(new NextRequest('http://panel.test/login/oauth/github/callback?code=c&state=s1'), {
      params: Promise.resolve({ provider: 'github' }),
    });
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('/mfa-verify?next=%2Faccept-invite%3Fid%3Dinv_1');
    expect(location).not.toContain(TOKEN);
    expect(challengeCookie(res)).toContain(`${MFA_CHALLENGE_COOKIE}=${TOKEN}`);
  });

  it('a completed sign-in drops any pending challenge', async () => {
    publicPost.mockResolvedValue({
      mfaRequired: false,
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { GET } = await import('@/app/login/magic-link/route');
    const res = await GET(new NextRequest('http://panel.test/login/magic-link?token=ml_1'));
    const cookie = challengeCookie(res);
    expect(cookie).toMatch(/Path=\/mfa-verify/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});

describe('sign-out', () => {
  it('drops a pending challenge on its own path', async () => {
    const { POST } = await import('@/app/sign-out/route');
    const res = await POST(new NextRequest('http://panel.test/sign-out', { method: 'POST' }));
    const cookie = challengeCookie(res);
    expect(cookie).toMatch(/Path=\/mfa-verify/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
