import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  publicPost,
  publicGet,
  setSessionCookies,
  PanelApiError,
  type AuthResponse,
} from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { TrackView } from '@/components/analytics/track-view';
import { AnalyticsEvent } from '@/lib/analytics';

type SignupMode = 'open' | 'invite' | 'closed';

/** Best-effort fetch of the deployment's registration mode (defaults open). */
async function fetchSignupMode(): Promise<SignupMode> {
  try {
    const { mode } = await publicGet<{ mode: SignupMode }>('/api/v1/tenant/auth/signup-mode');
    return mode === 'invite' || mode === 'closed' ? mode : 'open';
  } catch {
    // If the probe fails, fall back to the open form — the API still enforces
    // the real mode server-side, so a wrong guess can't bypass the gate.
    return 'open';
  }
}

async function signUp(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const workspaceName = String(formData.get('workspaceName') ?? '').trim();
  const inviteKey = String(formData.get('inviteKey') ?? '').trim();
  // Preserve what the operator typed (never the password, never the invite key)
  // so a failed submit doesn't blank the form — a common first-signup drop-off.
  // The invite key is deliberately NOT round-tripped through the URL.
  const keep = `&email=${encodeURIComponent(email)}&name=${encodeURIComponent(workspaceName)}`;
  if (!email || !password || !workspaceName) redirect(`/sign-up?error=missing${keep}`);

  try {
    const auth = await publicPost<AuthResponse>('/api/v1/tenant/auth/sign-up', {
      email,
      password,
      workspaceName,
      ...(inviteKey ? { inviteKey } : {}),
    });
    await setSessionCookies({ accessToken: auth.accessToken, refreshToken: auth.refreshToken });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/sign-up?error=${encodeURIComponent(err.code)}${keep}`);
    }
    throw err;
  }
  redirect('/applications?e=signup');
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'All fields are required.',
  EMAIL_ALREADY_EXISTS: 'That email is already registered. Sign in instead.',
  PASSWORD_TOO_SHORT: 'Password must be at least 8 characters.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  OPERATOR_SIGNUP_CLOSED: 'New operator registration is currently closed on this deployment.',
  OPERATOR_INVITE_REQUIRED: 'An invite key is required to sign up on this deployment.',
  OPERATOR_INVITE_INVALID: 'That invite key is not valid. Check it with whoever invited you.',
  OPERATOR_INVITE_USED: 'That invite key has already been used. Ask for a fresh one.',
  OPERATOR_INVITE_EXPIRED: 'That invite key has expired. Ask for a fresh one.',
  INTERNAL_ERROR: 'Something went wrong creating your workspace. Please try again.',
};

const GENERIC_ERROR = 'Something went wrong creating your workspace. Please try again.';

const INPUT_BASE =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const [params, mode] = await Promise.all([searchParams, fetchSignupMode()]);
  const error = typeof params.error === 'string' ? params.error : undefined;
  const keepEmail = typeof params.email === 'string' ? params.email : undefined;
  const keepName = typeof params.name === 'string' ? params.name : undefined;
  // Per-field errors render at the broken field instead of the page-top
  // banner (WP4) — the operator's eye is already at the form.
  const emailError = error === 'EMAIL_ALREADY_EXISTS' ? ERROR_MESSAGES[error] : undefined;
  const passwordError = error === 'PASSWORD_TOO_SHORT' ? ERROR_MESSAGES[error] : undefined;
  const inviteError =
    error && error.startsWith('OPERATOR_INVITE') ? (ERROR_MESSAGES[error] ?? GENERIC_ERROR) : undefined;
  // Never echo a raw error code to the user — fall back to a friendly message.
  const bannerError =
    error && !emailError && !passwordError && !inviteError ? (ERROR_MESSAGES[error] ?? GENERIC_ERROR) : undefined;

  // Closed: no form at all — registration is disabled deployment-wide.
  if (mode === 'closed') {
    return (
      <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm text-center">
          <h1 className="text-2xl font-semibold">Registration closed</h1>
          <p className="text-sm text-[var(--color-muted-fg)]">
            New operator sign-up is disabled on this deployment. If you already have an account, sign in below.
          </p>
          <Link
            href="/login"
            className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <TrackView event={AnalyticsEvent.RegisterPageView} />
      <form action={signUp} className="w-full max-w-md space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Create your workspace</h1>
          <p className="text-sm text-[var(--color-muted-fg)]">
            {mode === 'invite'
              ? 'Sign-up is invite-only here. Paste the key you were given.'
              : "You'll be the owner. Invite teammates after sign-up."}
          </p>
        </div>

        {bannerError && (
          <p role="alert" className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {bannerError}
          </p>
        )}

        {mode === 'invite' && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Invite key</span>
            <input type="text" name="inviteKey" required autoFocus
              placeholder="rp_opinv_…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={inviteError ? true : undefined}
              className={
                inviteError
                  ? INPUT_BASE.replace('border-[var(--color-border)]', 'border-red-500') + ' font-mono'
                  : INPUT_BASE + ' font-mono'
              } />
            {inviteError && (
              <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{inviteError}</span>
            )}
          </label>
        )}

        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Workspace name</span>
          <input type="text" name="workspaceName" required autoFocus={mode !== 'invite'}
            defaultValue={keepName}
            placeholder="Acme Co"
            className={INPUT_BASE} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Email</span>
          <input type="email" name="email" required autoComplete="email"
            defaultValue={keepEmail}
            placeholder="you@example.com"
            aria-invalid={emailError ? true : undefined}
            className={
              'w-full rounded-md border bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
              (emailError
                ? 'border-red-500 focus:ring-red-500/30 focus:border-red-500'
                : 'border-[var(--color-border)] focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]')
            } />
          {emailError && (
            <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{emailError}</span>
          )}
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Password</span>
          <input type="password" name="password" required autoComplete="new-password" minLength={8}
            placeholder="at least 8 characters"
            aria-invalid={passwordError ? true : undefined}
            className={
              'w-full rounded-md border bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
              (passwordError
                ? 'border-red-500 focus:ring-red-500/30 focus:border-red-500'
                : 'border-[var(--color-border)] focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]')
            } />
          {passwordError && (
            <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{passwordError}</span>
          )}
        </label>
        <SubmitButton
          pendingLabel="Creating workspace…"
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        >
          Create workspace
        </SubmitButton>

        <p className="text-sm text-[var(--color-muted-fg)] text-center pt-2 border-t border-[var(--color-border)]">
          Already have an account?{' '}
          <Link href="/login" className="underline hover:text-[var(--color-fg)]">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
