/**
 * The sign-in page offers only the ways in the application allows, read from
 * the portal config the API computes from the rules it enforces.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortalAuthFacts, PortalBranding } from '@/lib/config';

const state = {
  auth: { password: true, magicLink: false, signup: false } as Pick<PortalAuthFacts, 'password' | 'magicLink' | 'signup'>,
  branding: {} as PortalBranding,
  signInLink: null as string | null,
  verifyEmailLink: null as string | null,
  mfaChallenge: null as string | null,
  signInEmail: undefined as string | undefined,
  providers: [] as Array<{ id: string; name: string }>,
};

vi.mock('@/lib/session', () => ({
  getPortalUser: async () => null,
  getMfaChallenge: async () => state.mfaChallenge,
  getSignInLink: async () => state.signInLink,
  getVerifyEmailLink: async () => state.verifyEmailLink,
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
  confirmEmailAction: async () => undefined,
}));
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

const { default: LoginPage } = await import('@/app/(portal)/[slug]/login/page');
const { default: ConfirmEmailPage } = await import('@/app/(portal)/[slug]/verify-email/confirm/page');

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await LoginPage({
    params: Promise.resolve({ slug: 'acme' }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
}

const PASSWORD_FIELD = 'name="password"';
const LINK_BUTTON = 'Email me a sign-in link';
const FORGOT = 'Forgot password?';
const IN_APP = 'happens in Acme itself';

beforeEach(() => {
  state.auth = { password: true, magicLink: false, signup: false };
  state.signInEmail = undefined;
  state.branding = {};
  state.signInLink = null;
  state.verifyEmailLink = null;
  state.mfaChallenge = null;
  state.providers = [];
});

async function renderConfirm(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await ConfirmEmailPage({
    params: Promise.resolve({ slug: 'acme' }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
}

const RESEND_BUTTON = 'Send a new confirmation link';

describe('sign-in page by allowed method', () => {
  it('password only: the password form and the reset link, no sign-in link form', async () => {
    const html = await render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(PASSWORD_FIELD);
    expect(html).toContain(FORGOT);
    expect(html).not.toContain(LINK_BUTTON);
    expect(html).not.toContain(IN_APP);
  });

  it('sign-in link only: an email-only form, no password field and no reset link', async () => {
    state.auth = { password: false, magicLink: true, signup: false };
    const html = await render();
    expect(html).toContain(LINK_BUTTON);
    expect(html).not.toContain(PASSWORD_FIELD);
    expect(html).not.toContain(FORGOT);
  });

  it('both: password first as the primary action, the link option beneath it', async () => {
    state.auth = { password: true, magicLink: true, signup: false };
    const html = await render();
    expect(html.indexOf(PASSWORD_FIELD)).toBeGreaterThan(-1);
    expect(html.indexOf(LINK_BUTTON)).toBeGreaterThan(html.indexOf(PASSWORD_FIELD));
    expect(html).toContain(FORGOT);
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)</g)];
    const primary = buttons.filter(([, cls]) => cls!.includes('bg-[var(--color-primary)]')).map(([, , label]) => label);
    expect(primary).toEqual(['Sign in']);
  });

  it('neither: says sign-in happens in the application, with the support link and no form', async () => {
    state.auth = { password: false, magicLink: false, signup: false };
    state.branding = { supportEmail: 'help@acme.example' };
    const html = await render();
    expect(html).toContain(IN_APP);
    expect(html).toContain('href="mailto:help@acme.example"');
    expect(html).not.toContain('<form');
  });
});

it('after a reset page found passwords turned off, says there is no password to reset', async () => {
  state.auth = { password: false, magicLink: true, signup: false };
  expect(await render({ reason: 'password_off' })).toContain('there is no password to reset');
});

describe('sign-in link states', () => {
  it('with sign-up closed, the sent message holds whether or not the address has an account', async () => {
    state.auth = { password: true, magicLink: true, signup: false };
    const html = await render({ link: 'sent' });
    expect(html).toContain('If that address can sign in here, we sent it a link.');
    expect(html).not.toContain('creates your account');
  });

  it('with sign-up open, says the link creates the account for a new address and that it was sent', async () => {
    state.auth = { password: true, magicLink: true, signup: true };
    const html = await render({ link: 'sent' });
    expect(html).toContain('creates your account if you are new');
    expect(html).toContain('We sent a sign-in link to that address.');
    expect(html).not.toContain('If that address');
  });

  it('with a link waiting, asks for one click to sign in instead of spending it on load', async () => {
    state.signInLink = 'token';
    const html = await render({ step: 'link' });
    expect(html).toContain('Finish signing in');
    expect(html).not.toContain('token');
  });

  it('with no link waiting, says it expired or was used and offers a new one', async () => {
    state.auth = { password: false, magicLink: true, signup: false };
    const html = await render({ step: 'link' });
    expect(html).toContain('expired or was already used');
    expect(html).toContain(LINK_BUTTON);
  });

  it('explains an expired link and offers a new one', async () => {
    state.auth = { password: false, magicLink: true, signup: false };
    const html = await render({ error: 'MAGIC_LINK_EXPIRED' });
    expect(html).toContain('This sign-in link expired');
    expect(html).toContain(LINK_BUTTON);
  });
});

describe('the address typed into a failed sign-in', () => {
  it('fills the form from the cookie after an error, and never from the address bar', async () => {
    state.signInEmail = 'pat@example.com';
    expect(await render({ error: 'INVALID_CREDENTIALS' })).toContain('value="pat@example.com"');
    expect(await render()).not.toContain('value="pat@example.com"');
    state.signInEmail = undefined;
    expect(await render({ error: 'INVALID_CREDENTIALS', email: 'mallory@example.com' })).not.toContain('mallory');
  });
});

describe('an unconfirmed email address on the sign-in page', () => {
  it('offers a new confirmation link for the address just typed, in place of the sign-in forms', async () => {
    state.signInEmail = 'a@example.com';
    const html = await render({ error: 'EMAIL_NOT_VERIFIED' });
    expect(html).toContain('role="alert"');
    expect(html).toContain(RESEND_BUTTON);
    expect(html).toContain('value="a@example.com"');
    expect(html).not.toContain(PASSWORD_FIELD);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('after a request, shows the neutral sent message whatever the address', async () => {
    const html = await render({ resend: 'sent' });
    expect(html).toContain('If that address needs confirming, we sent a new link');
    expect(html).toContain(PASSWORD_FIELD);
  });

  it('says when the request was throttled and keeps the form', async () => {
    const html = await render({ resend_error: 'RATE_LIMITED', retry: '600' });
    expect(html).toContain('Wait about 10 minutes');
    expect(html).toContain(RESEND_BUTTON);
  });
});

describe('the email confirmation page', () => {
  it('with a link waiting, asks for one click instead of spending it on load', async () => {
    state.verifyEmailLink = 'ev_token';
    const html = await renderConfirm();
    expect(html).toContain('Confirm email address');
    expect(html).not.toContain('ev_token');
    expect(html).not.toContain(RESEND_BUTTON);
  });

  it('once confirmed, says so and links to sign in', async () => {
    const html = await renderConfirm({ done: '1' });
    expect(html).toContain('Your email address is confirmed');
    expect(html).toContain('href="/acme/login"');
  });

  it('explains an expired link and offers a new one', async () => {
    const html = await renderConfirm({ error: 'EMAIL_VERIFICATION_TOKEN_EXPIRED' });
    expect(html).toContain('This confirmation link expired');
    expect(html).toContain(RESEND_BUTTON);
  });

  it('with no link waiting, says it expired or was used and offers a new one', async () => {
    const html = await renderConfirm();
    expect(html).toContain('expired or was already used');
    expect(html).toContain(RESEND_BUTTON);
  });

  it('after a request, shows the neutral sent message', async () => {
    expect(await renderConfirm({ resend: 'sent' })).toContain('If that address needs confirming, we sent a new link');
  });
});

describe('the two-factor code step', () => {
  it('takes a text keyboard, since backup codes contain letters', async () => {
    state.mfaChallenge = 'challenge';
    const html = await render({ step: 'mfa' });
    expect(html).toContain('inputMode="text"');
    expect(html).toContain('autoComplete="one-time-code"');
  });
});

describe('social sign-in on the sign-in page', () => {
  const GOOGLE = { id: 'google', name: 'Google' };
  const GITHUB = { id: 'github', name: 'GitHub' };

  it('offers one button per provider, in the order and with the names the API gives', async () => {
    state.providers = [GITHUB, GOOGLE];
    const html = await render();
    const labels = [...html.matchAll(/Continue with (?:<!-- -->)?([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(['GitHub', 'Google']);
  });

  it('with no password or sign-in link, the providers are the way in instead of the go-to-the-app message', async () => {
    state.auth = { password: false, magicLink: false, signup: true };
    state.providers = [GOOGLE];
    const html = await render();
    expect(html).toContain('Google');
    expect(html).toContain('Continue with');
    expect(html).not.toContain(IN_APP);
    expect(html).toContain('href="/acme/sign-up"');
  });

  it('names the provider when it explains a refusal only social sign-in has', async () => {
    state.providers = [GOOGLE];
    const html = await render({ social_error: 'OAUTH_EMAIL_NOT_VERIFIED', provider: 'google' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Google has not confirmed the email address on that account');
  });
});
