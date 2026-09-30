import * as React from 'react';
import type { Metadata } from 'next';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { publicPost, setSessionCookies, PanelApiError, type AuthResponse } from '@/lib/api';
import { API_URL_MISSING_MESSAGES } from '@/lib/error-code';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';
import { safeNext } from '@/lib/safe-next';
import { MFA_CHALLENGE_COOKIE, clearMfaChallenge, mfaVerifyPath } from '@/lib/mfa-challenge';

export const metadata: Metadata = { title: 'Two-factor authentication · Rekey' };

/**
 * MFA challenge step for operator sign-in.
 *
 * Reached only after a first factor returned `mfaRequired: true`. The sign-in
 * step stored the challenge token in the {@link MFA_CHALLENGE_COOKIE} cookie,
 * never the URL. The token is single-use, 5-minute-lifetime, and only valid for
 * the operator that just passed the primary factor.
 */

/** API codes after which the stored challenge can never succeed. */
const SPENT_CHALLENGE_CODES = new Set(['MFA_CHALLENGE_INVALID', 'MFA_CHALLENGE_USED']);

async function verify(formData: FormData): Promise<void> {
  'use server';
  const jar = await cookies();
  const challenge = jar.get(MFA_CHALLENGE_COOKIE)?.value ?? '';
  const code = String(formData.get('code') ?? '').trim();
  const next = safeNext(formData.get('next'));
  if (!challenge) redirect(mfaVerifyPath({ next, error: 'MFA_CHALLENGE_INVALID' }));
  if (!code) redirect(mfaVerifyPath({ next, error: 'missing' }));

  let result: AuthResponse;
  try {
    result = await publicPost<AuthResponse>('/api/v1/tenant/auth/mfa-verify', {
      mfaChallengeToken: challenge,
      code,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      // A wrong code keeps the challenge so the operator can retry without
      // signing in again; a spent or expired one is dropped.
      if (SPENT_CHALLENGE_CODES.has(err.code)) clearMfaChallenge(jar);
      redirect(mfaVerifyPath({ next, error: err.code }));
    }
    throw err;
  }

  clearMfaChallenge(jar);
  await setSessionCookies(result);
  if (next) redirect(`${next}${next.includes('?') ? '&' : '?'}e=login_mfa`);
  redirect('/applications?e=login_mfa');
}

const ERROR_MESSAGES: Record<string, string> = {
  ...API_URL_MISSING_MESSAGES,
  missing: 'Authenticator code is required.',
  MFA_CODE_INVALID: 'That code didn\'t verify. Try the current 6-digit code or a backup code.',
  MFA_CODE_REUSED:
    'That code was already used. Wait for your authenticator to show the next code, then enter it.',
  MFA_CHALLENGE_INVALID: 'This sign-in expired. Sign in again to get a new code prompt.',
  MFA_CHALLENGE_USED: 'This sign-in was already completed. Sign in again to start over.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL_ERROR: 'Something went wrong verifying that code. Please try again.',
};

export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const hasChallenge = Boolean((await cookies()).get(MFA_CHALLENGE_COOKIE)?.value);
  // Only codes we have copy for render a banner, an unrecognized `?error=`
  // value shows nothing rather than an unexplained "something went wrong".
  const error = typeof params.error === 'string' ? ERROR_MESSAGES[params.error] : undefined;
  const next = safeNext(typeof params.next === 'string' ? params.next : null) ?? undefined;
  const signInAgain = `/login${next ? `?next=${encodeURIComponent(next)}` : ''}`;

  if (!hasChallenge) {
    return (
      <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
        <div className="w-full max-w-md space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
          <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
          <Banner tone="error">
            {error ?? 'This sign-in expired or was already finished. Sign in again to continue.'}
          </Banner>
          <Link
            href={signInAgain}
            className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            Sign in again
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <ActionForm
        action={verify}
        className="w-full max-w-md space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
          <p className="text-sm text-[var(--color-muted-fg)]">
            Enter the current 6-digit code from your authenticator app, or one
            of the backup codes you saved at enrollment.
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        {next && <input type="hidden" hidden name="next" value={next} />}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Code</span>
          <input
            type="text"
            name="code"
            required
            autoFocus
            inputMode="numeric"
            pattern="[A-Za-z0-9\-]+"
            autoComplete="one-time-code"
            placeholder="123456"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          />
        </label>
        <SubmitButton
          pendingLabel="Verifying…"
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          Verify
        </SubmitButton>

        <div className="flex items-center justify-end text-sm text-[var(--color-muted-fg)] pt-2 border-t border-[var(--color-border)]">
          <Link href={signInAgain} className="hover:text-[var(--color-fg)]">
            Back to sign-in
          </Link>
        </div>
      </ActionForm>
    </main>
  );
}
