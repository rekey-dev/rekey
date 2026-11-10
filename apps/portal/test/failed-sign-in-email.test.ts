/**
 * After a failed sign-in the form offers the typed address again. The address
 * waits in a short httpOnly cookie on the application's path, never in the
 * URL, and is gone once sign-in succeeds.
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

const client = { signIn: vi.fn() };

vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ publishableKey: 'pk_test', billingSubject: 'user' }),
  PortalConfigUnavailableError: class extends Error {},
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
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  portalClientFor: async () => client,
}));

const session = await import('@/lib/session');
const { signInAction } = await import('@/lib/actions');

async function signIn(email: string): Promise<string> {
  const f = new FormData();
  f.set('email', email);
  f.set('password', 'pw');
  try {
    await signInAction('acme', f);
  } catch (err) {
    const m = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}

beforeEach(() => {
  jar.clear();
  client.signIn.mockReset();
});

describe('the address typed into a failed sign-in', () => {
  it('waits in a short httpOnly cookie on the application path, not in the URL', async () => {
    client.signIn.mockRejectedValueOnce(new RekeyError({ statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'no' } as never));
    const to = await signIn('pat@example.com');
    expect(to).toBe('/acme/login?error=INVALID_CREDENTIALS');
    expect(to).not.toContain('pat');
    expect(jar.get(session.SIGN_IN_EMAIL)).toEqual({
      value: 'pat@example.com',
      options: expect.objectContaining({ httpOnly: true, path: '/acme', maxAge: 5 * 60 }),
    });
  });

  it('is cleared when sign-in succeeds', async () => {
    jar.set(session.SIGN_IN_EMAIL, { value: 'pat@example.com', options: { maxAge: 300 } });
    client.signIn.mockResolvedValueOnce({ mfaRequired: false, accessToken: 'at', refreshToken: 'rt' });
    expect(await signIn('pat@example.com')).toBe('/acme');
    expect(jar.get(session.SIGN_IN_EMAIL)?.options.maxAge).toBe(0);
  });
});
