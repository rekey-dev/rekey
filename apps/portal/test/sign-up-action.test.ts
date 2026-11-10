/**
 * What submitting the create-account form does with each answer the API can
 * give, and with a bot that filled the hidden field.
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

const client = { signUp: vi.fn() };

vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ publishableKey: 'rp_pub_test', billingSubject: 'user' }),
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
const { signUpAction } = await import('@/lib/sign-up-actions');

async function submit(fields: Record<string, string>): Promise<string> {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  try {
    await signUpAction('acme', f);
  } catch (err) {
    const m = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}

function refuse(code: string, statusCode = 400, retryAfterSeconds?: number): void {
  client.signUp.mockRejectedValueOnce(
    new RekeyError({ statusCode, code, message: 'no', ...(retryAfterSeconds && { retryAfterSeconds }) } as never),
  );
}

const SESSION = {
  mfaRequired: false,
  accessToken: 'at',
  refreshToken: 'rt',
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

beforeEach(() => {
  jar.clear();
  client.signUp.mockReset();
});

describe('a create-account submission', () => {
  it('with the hidden field filled shows the inbox state without asking the API', async () => {
    expect(await submit({ email: 'bot@example.com', password: 'hunter22hunter', rk_hp_7f3: 'spam' })).toBe(
      '/acme/sign-up?sent=1',
    );
    expect(client.signUp).not.toHaveBeenCalled();
  });

  it('asks the API to link the confirmation email to this portal', async () => {
    refuse('EMAIL_NOT_VERIFIED', 403);
    await submit({ email: 'pat@example.com', password: 'a long password' });
    expect(client.signUp).toHaveBeenCalledWith({
      email: 'pat@example.com',
      password: 'a long password',
      verifyUrl: 'https://portal.example/acme/verify-email?token={token}',
    });
  });

  it('that must confirm the address shows the inbox state, keeping the address for the resend form only', async () => {
    refuse('EMAIL_NOT_VERIFIED', 403);
    const to = await submit({ email: 'pat@example.com', password: 'a long password' });
    expect(to).toBe('/acme/sign-up?sent=1');
    expect(jar.get(session.SIGN_IN_EMAIL)?.value).toBe('pat@example.com');
  });

  it('that gets a session signs in through the shared ending, landing on the page it came from', async () => {
    client.signUp.mockResolvedValueOnce(SESSION);
    const to = await submit({ email: 'pat@example.com', password: 'a long password', return: 'devices' });
    expect(to).toBe('/acme/devices');
    expect(jar.get(session.ACCESS)?.value).toBe('at');
    expect(jar.get(session.REFRESH)?.value).toBe('rt');
    expect(jar.get(session.SIGN_IN_EMAIL)?.options.maxAge).toBe(0);
  });

  it('that the API refuses goes back to the form with the code, the address kept and never the password', async () => {
    refuse('EMAIL_ALREADY_EXISTS', 409);
    const to = await submit({ email: 'pat@example.com', password: 'a long password' });
    expect(to).toBe('/acme/sign-up?error=EMAIL_ALREADY_EXISTS');
    expect(jar.get(session.SIGN_IN_EMAIL)?.value).toBe('pat@example.com');
    expect(JSON.stringify([...jar.values()])).not.toContain('a long password');
  });

  it('that is throttled carries the wait back to the page', async () => {
    refuse('RATE_LIMITED', 429, 600);
    expect(await submit({ email: 'pat@example.com', password: 'a long password' })).toBe(
      '/acme/sign-up?error=RATE_LIMITED&retry=600',
    );
  });
});
