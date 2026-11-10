/**
 * The create-account page: offered only while the application allows public
 * sign-up, by the method it allows, and every answer the API can give has its
 * own state on the page.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalAuthFacts, PortalBranding } from '@/lib/config';

const state = {
  auth: { password: true, magicLink: false, signup: true } as Pick<PortalAuthFacts, 'password' | 'magicLink' | 'signup'>,
  branding: {} as PortalBranding,
  signInEmail: undefined as string | undefined,
  providers: [] as Array<{ id: string; name: string }>,
};

vi.mock('@/lib/session', () => ({
  getPortalUser: async () => null,
  getMfaChallenge: async () => null,
  getSignInLink: async () => null,
  getSignInEmail: async () => state.signInEmail,
}));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({ name: 'Acme', auth: state.auth, branding: state.branding }),
}));
vi.mock('@/lib/actions', () => ({
  signInAction: async () => undefined,
  mfaVerifyAction: async () => undefined,
  requestSignInLinkAction: async () => undefined,
  signInWithLinkAction: async () => undefined,
  resendVerificationAction: async () => undefined,
}));
vi.mock('@/lib/sign-up-actions', () => ({ signUpAction: async () => undefined }));
vi.mock('@/lib/social-sign-in', () => ({ socialSignInProviders: async () => state.providers }));
vi.mock('@/lib/social-sign-in-actions', () => ({ startSocialSignInAction: async () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
}));

const { default: SignUpPage } = await import('@/app/(portal)/[slug]/sign-up/page');
const { default: LoginPage } = await import('@/app/(portal)/[slug]/login/page');

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await SignUpPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) }),
  );
}

async function renderLogin(searchParams: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await LoginPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) }),
  );
}

/** The opening tag of the input named `name`. */
function input(html: string, name: string): string {
  return new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';
}

beforeEach(() => {
  state.auth = { password: true, magicLink: false, signup: true };
  state.branding = {};
  state.signInEmail = undefined;
  state.providers = [];
});

describe('where sign-up is offered', () => {
  it('with sign-up closed the page goes to sign-in, and sign-in offers no way to create an account', async () => {
    state.auth = { password: true, magicLink: true, signup: false };
    await expect(render()).rejects.toThrow('REDIRECT /acme/login');
    expect(await renderLogin()).not.toContain('/acme/sign-up');
  });

  it('with sign-up open, sign-in links to it and carries the return page along', async () => {
    expect(await renderLogin({ return: 'devices' })).toContain('href="/acme/sign-up?return=devices"');
  });

  it('with no password, sign-in link or provider allowed there is nothing to create an account with', async () => {
    state.auth = { password: false, magicLink: false, signup: true };
    await expect(render()).rejects.toThrow('REDIRECT /acme/login');
  });

  it('with only social providers allowed, creating an account is a provider button', async () => {
    state.auth = { password: false, magicLink: false, signup: true };
    state.providers = [{ id: 'google', name: 'Google' }];
    const html = await render();
    expect(html).toContain('Create an account');
    expect(html).toMatch(/Continue with (<!-- -->)?Google/);
    expect(html).not.toContain('name="email"');
  });
});

describe('the password form', () => {
  it('asks for an email and a new password only, with the rule and a show toggle', async () => {
    const html = await render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(input(html, 'email')).toMatch(/autocomplete="email"/i);
    expect(input(html, 'password')).toMatch(/autocomplete="new-password"/i);
    expect(html).toContain('At least 8 characters');
    expect(html).toContain('Show password');
    const visible = [...html.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(visible).toEqual(['rk_hp_7f3', 'email', 'password']);
  });

  it('hides the honeypot from people, screen readers and autofill', async () => {
    const html = await render();
    expect(html).toMatch(/<div aria-hidden="true"[^>]*><label>Leave this empty<input[^>]*tabindex="-1"/);
    const honeypot = input(html, 'rk_hp_7f3');
    expect(honeypot).toMatch(/type="text"/);
    expect(honeypot).toMatch(/aria-hidden="true"/);
    expect(honeypot).toMatch(/autocomplete="off"/i);
  });

  it('names the terms and privacy policy under the button when the operator set them', async () => {
    state.branding = { termsUrl: 'https://acme.example/terms', privacyUrl: 'https://acme.example/privacy' };
    const html = await render();
    expect(html).toContain('By creating an account you agree to the');
    expect(html).toContain('href="https://acme.example/terms"');
    expect(html).toContain('href="https://acme.example/privacy"');
    expect(html.indexOf('Create account</button>')).toBeLessThan(html.indexOf('By creating an account'));
    expect(html).not.toContain('type="checkbox"');
  });

  it('says nothing about agreeing when the operator set neither', async () => {
    expect(await render()).not.toContain('you agree');
  });

  it('names the privacy policy alone when that is all the operator set', async () => {
    state.branding = { privacyUrl: 'https://acme.example/privacy' };
    expect(await render()).toContain('you agree to the <a href="https://acme.example/privacy"');
  });
});

it('with only sign-in links allowed, offers the emailed link that creates the account', async () => {
  state.auth = { password: false, magicLink: true, signup: true };
  const html = await render();
  expect(html).toContain('Opening it creates your account and signs you in.');
  expect(html).toContain('Email me a link');
  expect(input(html, 'password')).toBe('');
});

describe('after submitting', () => {
  it('a confirmation to send shows the inbox state with the resend control and says nothing about the address', async () => {
    state.signInEmail = 'pat@example.com';
    const html = await render({ sent: '1' });
    expect(html).toContain('Check your inbox');
    expect(html).toContain('Send a new confirmation link');
    expect(input(html, 'email')).toContain('value="pat@example.com"');
    expect(html).not.toMatch(/already|exists/i);
  });

  it('an address that already has an account says so under the email field with a sign-in link', async () => {
    state.signInEmail = 'pat@example.com';
    const html = await render({ error: 'EMAIL_ALREADY_EXISTS' });
    expect(input(html, 'email')).toContain('value="pat@example.com"');
    expect(input(html, 'email')).toContain('aria-invalid="true"');
    expect(html).toContain('You already have an account. Sign in instead.');
    expect(html).toContain('Go to sign in');
    expect(input(html, 'password')).not.toContain('value=');
  });

  it.each([
    ['SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED', 'email', 'cannot be used to create an account here'],
    ['PASSWORD_TOO_SHORT', 'password', 'That password is too short'],
    ['PASSWORD_BREACHED', 'password', 'known data breach'],
  ])('%s is explained under the %s field, which takes focus', async (code, field, text) => {
    state.signInEmail = 'pat@example.com';
    const html = await render({ error: code });
    expect(html).toContain(text);
    expect(input(html, field)).toContain('aria-invalid="true"');
    expect(input(html, field)).toMatch(/autofocus/i);
    expect(input(html, 'email')).toContain('value="pat@example.com"');
  });

  it('a throttled sign-up says how long to wait, in an alert', async () => {
    const html = await render({ error: 'RATE_LIMITED', retry: '600' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Wait about 10 minutes');
  });
});
