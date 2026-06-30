import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import {
  publicPost,
  publicGet,
  setSessionCookies,
  PanelApiError,
  type SignInResponse,
} from '@/lib/api';
import { PasskeyLoginButton } from '@/components/PasskeyLoginButton';
import { SubmitButton } from '@/components/SubmitButton';
import { TrackView } from '@/components/analytics/track-view';
import { AnalyticsEvent } from '@/lib/analytics';

async function signIn(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  // Preserve the typed email (never the password) so a failed sign-in doesn't
  // make the operator retype it.
  const keep = `&email=${encodeURIComponent(email)}`;
  if (!email || !password) redirect(`/login?error=missing${keep}`);

  let result: SignInResponse;
  try {
    result = await publicPost<SignInResponse>('/api/v1/tenant/auth/sign-in', { email, password });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/login?error=${encodeURIComponent(err.code)}${keep}`);
    }
    throw err;
  }

  // MFA enrolled — redirect to the verify page carrying the challenge
  // token in the URL. The token is single-use, 5-min-lifetime, and bound
  // to this operator + this sign-in attempt.
  if (result.mfaRequired) {
    redirect(
      `/mfa-verify?challenge=${encodeURIComponent(result.mfaChallengeToken)}`,
    );
  }

  await setSessionCookies({ accessToken: result.accessToken, refreshToken: result.refreshToken });
  redirect('/applications?e=login');
}

/** Begin a passkey sign-in — returns the assertion options for the browser. */
async function startPasskeyLogin(): Promise<
  | { ok: true; options: Record<string, unknown>; expectedChallenge: string }
  | { ok: false; message: string }
> {
  'use server';
  try {
    const data = await publicPost<{ options: Record<string, unknown>; expectedChallenge: string }>(
      '/api/v1/tenant/auth/passkeys/authenticate/start',
      {},
    );
    return { ok: true, ...data };
  } catch (err) {
    if (err instanceof PanelApiError) {
      return { ok: false, message: ERROR_MESSAGES[err.code] ?? err.message };
    }
    throw err;
  }
}

/** Verify the assertion + mint a session. Redirects on success or failure. */
async function completePasskeyLogin(formData: FormData): Promise<void> {
  'use server';
  const expectedChallenge = String(formData.get('expectedChallenge') ?? '');
  let response: unknown;
  try {
    response = JSON.parse(String(formData.get('response') ?? ''));
  } catch {
    redirect('/login?error=PASSKEY_RESPONSE_INVALID');
  }
  let result: { accessToken: string; refreshToken: string };
  try {
    result = await publicPost<{ accessToken: string; refreshToken: string }>(
      '/api/v1/tenant/auth/passkeys/authenticate/complete',
      { response, expectedChallenge },
    );
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/login?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  await setSessionCookies({ accessToken: result.accessToken, refreshToken: result.refreshToken });
  redirect('/applications?e=login_passkey');
}

/**
 * Begin an operator OAuth sign-in. Stash a one-shot CSRF `state` in an httpOnly
 * cookie, then redirect the browser to the provider. The callback route
 * (/login/oauth/[provider]/callback) verifies the cookie against the returned
 * `state` before exchanging the code.
 *
 * `_formData` is the Next bound-action arg (ignored — provider is bound).
 */
async function startOAuth(provider: string, _formData: FormData): Promise<void> {
  'use server';
  const state = randomUUID();
  const jar = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  // `lax`, not `strict`: the provider redirects back via a top-level cross-site
  // GET on which a Strict cookie is NOT sent — which would break the CSRF check.
  const opts = { httpOnly: true as const, sameSite: 'lax' as const, secure, path: '/', maxAge: 600 };
  jar.set('oauth_state', state, opts);
  jar.set('oauth_provider', provider, opts);
  let authorizationUrl: string;
  try {
    const data = await publicPost<{ authorizationUrl: string }>(
      `/api/v1/tenant/auth/oauth/${encodeURIComponent(provider)}/start`,
      { state },
    );
    authorizationUrl = data.authorizationUrl;
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/login?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(authorizationUrl);
}

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Email and password are required.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  NO_TENANT_MEMBERSHIPS: 'Your account has no workspace memberships. Ask an owner for an invite.',
  PASSKEY_UNKNOWN: 'No operator account matches that passkey. Register it first under Account → Passkeys.',
  PASSKEY_AUTHENTICATION_FAILED: 'Passkey sign-in did not verify. Try again.',
  PASSKEY_RESPONSE_INVALID: 'The browser returned an invalid passkey response. Retry.',
  WEBAUTHN_NOT_CONFIGURED: 'Passkey sign-in is not enabled on this deployment.',
  OAUTH_PROVIDER_NOT_CONFIGURED: 'That sign-in provider is not enabled on this deployment.',
  OAUTH_PROVIDER_UNKNOWN: 'Unknown sign-in provider.',
  OAUTH_EMAIL_NOT_VERIFIED: 'Your provider account email is not verified — verify it at the provider, then retry.',
  OAUTH_NO_EMAIL: 'Your provider account did not share an email. Grant email access, then retry.',
  oauth_state: 'Sign-in session expired or could not be verified. Please try again.',
  oauth_denied: 'Sign-in was cancelled at the provider.',
  magic_link_missing: 'That sign-in link is missing its token. Request a fresh one.',
  MAGIC_LINK_TOKEN_INVALID: 'That sign-in link is invalid. Request a fresh one.',
  MAGIC_LINK_TOKEN_USED: 'That sign-in link was already used. Request a fresh one.',
  MAGIC_LINK_TOKEN_EXPIRED: 'That sign-in link expired. Request a fresh one.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const reason = typeof params.reason === 'string' ? params.reason : undefined;
  const keepEmail = typeof params.email === 'string' ? params.email : undefined;

  // Which social providers are enabled on this deployment (server env). Empty
  // (or unreachable API) → no social buttons, just password + passkey.
  const oauthProviders = await publicGet<{ providers: string[] }>('/api/v1/tenant/auth/oauth/providers')
    .then((d) => d.providers)
    .catch(() => [] as string[]);

  const inputCls =
    'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <TrackView event={AnalyticsEvent.LoginPageView} />
      <div className="w-full max-w-md space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Sign in to ReliPay</h1>
          <p className="text-sm text-[var(--color-muted-fg)]">
            Operator account — manage Applications, billing, and team.
          </p>
        </div>

        {reason === 'expired' && (
          <p className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            Your session expired. Please sign in again.
          </p>
        )}
        {error && (
          <p role="alert" className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERROR_MESSAGES[error] ?? 'Something went wrong. Please try again.'}
          </p>
        )}

        {oauthProviders.length > 0 && (
          <>
            <div className="space-y-2">
              {oauthProviders
                .filter((p) => p in PROVIDER_LABELS)
                .map((p) => (
                  <form key={p} action={startOAuth.bind(null, p)}>
                    <OAuthButton provider={p} label={PROVIDER_LABELS[p]!} />
                  </form>
                ))}
            </div>
            <OrDivider />
          </>
        )}

        <form action={signIn} className="space-y-5">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Email</span>
            <input type="email" name="email" required autoComplete="email"
              defaultValue={keepEmail}
              placeholder="you@example.com" className={inputCls} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Password</span>
            <input type="password" name="password" required autoComplete="current-password" className={inputCls} />
          </label>
          <SubmitButton
            pendingLabel="Signing in…"
            className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            Sign in
          </SubmitButton>
        </form>

        {/* Passwordless alternative — phishing-resistant, no second factor needed. */}
        <OrDivider />
        <PasskeyLoginButton start={startPasskeyLogin} complete={completePasskeyLogin} />

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-[var(--color-muted-fg)] pt-2 border-t border-[var(--color-border)]">
          <Link href="/sign-up" className="hover:text-[var(--color-fg)]">
            Create workspace
          </Link>
          <Link href="/magic-link" className="hover:text-[var(--color-fg)]">
            Email a sign-in link
          </Link>
          <Link href="/forgot-password" className="hover:text-[var(--color-fg)]">
            Forgot password?
          </Link>
        </div>

        <p className="text-center text-xs text-[var(--color-muted-fg)]">
          Test environment — data may be reset without notice.{' '}
          <a
            href="https://discord.gg/rCw3ydefq"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-[var(--color-fg)]"
          >
            Request production access
          </a>
          .
        </p>
      </div>
    </main>
  );
}

function OrDivider(): React.JSX.Element {
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center" aria-hidden="true">
        <div className="w-full border-t border-[var(--color-border)]" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-[var(--color-surface)] px-2 text-xs text-[var(--color-muted-fg)]">or</span>
      </div>
    </div>
  );
}

function OAuthButton({ provider, label }: { provider: string; label: string }): React.JSX.Element {
  return (
    <SubmitButton
      pendingLabel="Redirecting…"
      className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <ProviderIcon provider={provider} />
      {label}
    </SubmitButton>
  );
}

function ProviderIcon({ provider }: { provider: string }): React.JSX.Element | null {
  if (provider === 'google') {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.26.8-.57v-2c-3.34.73-4.04-1.6-4.04-1.6-.55-1.4-1.34-1.77-1.34-1.77-1.1-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .31.2.68.81.57A12 12 0 0 0 12 .5z" />
      </svg>
    );
  }
  return null;
}
