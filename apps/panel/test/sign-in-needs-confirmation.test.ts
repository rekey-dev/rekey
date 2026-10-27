/**
 * A sign-in link or handoff that another party can put in front of the
 * operator never signs the browser in on its own: opening a magic link spends
 * nothing, and a Cloud handoff from another site waits for the operator to
 * confirm.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicPost = vi.fn();
const jar = new Map<string, string>();
const deleted: string[] = [];

vi.mock('@/lib/cookie-secure', () => ({ cookieSecure: async () => true }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (arg: string | { name: string }) => {
      const name = typeof arg === 'string' ? arg : arg.name;
      deleted.push(name);
      jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, publicPost: (...args: unknown[]) => publicPost(...args) };
});

const { PanelApiError } = await import('@/lib/api');
const { MFA_CHALLENGE_COOKIE } = await import('@/lib/mfa-challenge');
const { CLOUD_HANDOFF_COOKIE, handoffEmail } = await import('@/app/login/cloud/handoff-cookie');

const SIGNED_IN = {
  mfaRequired: false,
  accessToken: 'access-new',
  refreshToken: 'refresh-new',
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function idToken(payload: Record<string, unknown>): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(payload)}.sig`;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function cloudPost(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://panel.test/login/cloud', {
    method: 'POST',
    body: new URLSearchParams({ id_token: 'idt_attacker' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
}

beforeEach(() => {
  publicPost.mockReset();
  jar.clear();
  deleted.length = 0;
});

describe('magic link', () => {
  it('opening the link renders a confirm page and spends nothing', async () => {
    const { default: Page } = await import('@/app/login/magic-link/page');
    await Page({ searchParams: Promise.resolve({ token: 'ml_1' }) });
    expect(publicPost).not.toHaveBeenCalled();
  });

  it('a link with no token goes back to sign-in', async () => {
    const { default: Page } = await import('@/app/login/magic-link/page');
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/login?error=magic_link_missing',
    );
  });

  it('continuing spends the token, signs in and drops a pending challenge', async () => {
    publicPost.mockResolvedValue(SIGNED_IN);
    jar.set(MFA_CHALLENGE_COOKIE, 'stale');
    const { continueMagicLinkSignIn } = await import('@/app/login/magic-link/actions');
    await expect(continueMagicLinkSignIn(form({ token: 'ml_1' }))).rejects.toThrow('NEXT_REDIRECT:/applications');
    expect(publicPost).toHaveBeenCalledWith('/api/v1/tenant/auth/magic-link/verify', { token: 'ml_1' });
    expect(jar.get('rekey_access')).toBe('access-new');
    expect(jar.get('rekey_refresh')).toBe('refresh-new');
    expect(deleted).toContain(MFA_CHALLENGE_COOKIE);
  });

  it('an MFA-enrolled operator is handed the challenge', async () => {
    publicPost.mockResolvedValue({ mfaRequired: true, mfaChallengeToken: 'chal_1' });
    const { continueMagicLinkSignIn } = await import('@/app/login/magic-link/actions');
    await expect(continueMagicLinkSignIn(form({ token: 'ml_1' }))).rejects.toThrow('NEXT_REDIRECT:/mfa-verify');
    expect(jar.get(MFA_CHALLENGE_COOKIE)).toBe('chal_1');
    expect(jar.has('rekey_access')).toBe(false);
  });

  it('a spent token reports the API code on the sign-in page', async () => {
    publicPost.mockRejectedValue(new PanelApiError({ statusCode: 400, code: 'MAGIC_LINK_TOKEN_USED', message: 'used' }));
    const { continueMagicLinkSignIn } = await import('@/app/login/magic-link/actions');
    await expect(continueMagicLinkSignIn(form({ token: 'ml_1' }))).rejects.toThrow(
      'NEXT_REDIRECT:/login?error=MAGIC_LINK_TOKEN_USED',
    );
  });
});

describe('Cloud handoff', () => {
  it('a cross-site post is held for confirmation, as a browser sends it (no Lax session cookie)', async () => {
    const { POST } = await import('@/app/login/cloud/route');
    const res = await POST(cloudPost({ 'sec-fetch-site': 'cross-site' }));
    expect(publicPost).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('/login/cloud/confirm');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${CLOUD_HANDOFF_COOKIE}=`));
    expect(cookie).toContain('idt_attacker');
    expect(cookie).toMatch(/Path=\/login\/cloud/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('rekey_access='))).toBe(false);
  });

  it('a post with no Sec-Fetch-Site is held too', async () => {
    const { POST } = await import('@/app/login/cloud/route');
    const res = await POST(cloudPost({}));
    expect(publicPost).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('/login/cloud/confirm');
  });

  it('signs in at once from the same site, signed in or not', async () => {
    publicPost.mockResolvedValue(SIGNED_IN);
    const { POST } = await import('@/app/login/cloud/route');
    for (const headers of [
      { 'sec-fetch-site': 'same-site', cookie: 'rekey_access=mine' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'same-origin' },
    ]) {
      const res = await POST(cloudPost(headers));
      expect(res.headers.get('location')).toBe('/applications?e=login_cloud');
    }
    expect(publicPost).toHaveBeenCalledTimes(3);
  });

  it('confirming spends the held token once and signs in', async () => {
    publicPost.mockResolvedValue(SIGNED_IN);
    jar.set(CLOUD_HANDOFF_COOKIE, 'idt_held');
    const { confirmCloudHandoff } = await import('@/app/login/cloud/confirm/actions');
    await expect(confirmCloudHandoff()).rejects.toThrow('NEXT_REDIRECT:/applications?e=login_cloud');
    expect(publicPost).toHaveBeenCalledWith('/api/v1/tenant/auth/oidc/assert', { idToken: 'idt_held' });
    expect(jar.has(CLOUD_HANDOFF_COOKIE)).toBe(false);
    expect(jar.get('rekey_access')).toBe('access-new');
  });

  it('confirming with nothing held goes back to sign-in', async () => {
    const { confirmCloudHandoff } = await import('@/app/login/cloud/confirm/actions');
    await expect(confirmCloudHandoff()).rejects.toThrow('NEXT_REDIRECT:/login?error=cloud_handoff');
    expect(publicPost).not.toHaveBeenCalled();
  });

  it('keeping the current session drops the held token without spending it', async () => {
    jar.set(CLOUD_HANDOFF_COOKIE, 'idt_held');
    const { cancelCloudHandoff } = await import('@/app/login/cloud/confirm/actions');
    await expect(cancelCloudHandoff()).rejects.toThrow('NEXT_REDIRECT:/applications');
    expect(jar.has(CLOUD_HANDOFF_COOKIE)).toBe(false);
    expect(publicPost).not.toHaveBeenCalled();
  });

  it('shows the email the handoff would switch to', () => {
    expect(handoffEmail(idToken({ email: 'buyer@example.com' }))).toBe('buyer@example.com');
    expect(handoffEmail(idToken({ sub: 'op_1' }))).toBeNull();
    expect(handoffEmail('not-a-jwt')).toBeNull();
  });
});
