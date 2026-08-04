/**
 * The operator session cookie carries `Secure` because of the REQUEST, not
 * because of NODE_ENV.
 *
 * `setSessionCookies` decided `secure` with
 * `process.env.NODE_ENV === 'production'`. A panel behind TLS whose NODE_ENV
 * was unset, or `staging`, or anything Next did not inline as exactly
 * `"production"`, handed the operator a session cookie with no `Secure` flag —
 * and that cookie is a workspace-admin credential, which a browser will then
 * replay over plain HTTP to anyone who can force one downgraded request.
 *
 * Nothing about that misconfiguration is visible: the panel works, the operator
 * signs in, and the only symptom is a session credential that is one downgrade
 * away from being read off the wire. So it needs a test, and the test has to
 * run with NODE_ENV set to something OTHER than 'production' — under vitest it
 * is 'test', which is exactly the case that used to fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Written {
  name: string;
  value: string;
  opts: { secure?: boolean; httpOnly?: boolean; sameSite?: string };
}

const written: Written[] = [];
let requestHeaders = new Headers();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, opts: Written['opts']) => {
      written.push({ name, value, opts });
    },
    delete: () => undefined,
  }),
  headers: async () => requestHeaders,
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  forbidden: () => {
    throw new Error('NEXT_FORBIDDEN');
  },
}));

const { setSessionCookies } = await import('@/lib/api');

async function writeSession(headers: Record<string, string>): Promise<Written[]> {
  written.length = 0;
  requestHeaders = new Headers(headers);
  await setSessionCookies({ accessToken: 'a-token', refreshToken: 'r-token' });
  return [...written];
}

describe('operator session cookies', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.REKEY_COOKIE_SECURE;
  });
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.REKEY_COOKIE_SECURE;
  });

  it('is Secure behind TLS even though NODE_ENV is not "production"', async () => {
    // The regression, exactly. Under vitest NODE_ENV === 'test'.
    expect(process.env.NODE_ENV).not.toBe('production');
    const cookies = await writeSession({
      'x-forwarded-proto': 'https',
      host: 'panel.example.com',
    });
    expect(cookies).toHaveLength(2);
    for (const c of cookies) expect(c.opts.secure).toBe(true);
  });

  it('is Secure on a real host even when the proxy sets no forwarded proto', async () => {
    const cookies = await writeSession({ host: 'panel.example.com' });
    for (const c of cookies) expect(c.opts.secure).toBe(true);
  });

  it('is not Secure on http://localhost, so local dev still signs in', async () => {
    const cookies = await writeSession({ host: 'localhost:3031' });
    for (const c of cookies) expect(c.opts.secure).toBe(false);
  });

  it('honours REKEY_COOKIE_SECURE=false as the explicit opt-out', async () => {
    process.env.REKEY_COOKIE_SECURE = 'false';
    const cookies = await writeSession({ host: 'panel.example.com' });
    for (const c of cookies) expect(c.opts.secure).toBe(false);
  });

  it('keeps httpOnly and SameSite=Lax alongside it', async () => {
    // Guards the guard: a rewrite that dropped the other attributes while
    // getting `secure` right would still be a regression.
    const cookies = await writeSession({ 'x-forwarded-proto': 'https', host: 'p.example.com' });
    for (const c of cookies) {
      expect(c.opts.httpOnly).toBe(true);
      expect(c.opts.sameSite).toBe('lax');
    }
  });

  it('writes both the access and the refresh cookie', async () => {
    const cookies = await writeSession({ host: 'panel.example.com' });
    expect(cookies.map((c) => c.name).sort()).toEqual(['rekey_access', 'rekey_refresh']);
  });
});
