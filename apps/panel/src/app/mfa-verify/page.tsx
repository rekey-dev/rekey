import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  publicPost,
  setSessionCookies,
  PanelApiError,
  type AuthResponse,
} from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';

export const metadata: Metadata = { title: 'Two-factor authentication · Rekey' };

/**
 * MFA challenge step for operator sign-in.
 *
 * Reached only when /api/v1/tenant/auth/sign-in returned
 * `mfaRequired: true` and `/login` redirected here with the challenge
 * token in the query string. The token is single-use, 5-minute-lifetime,
 * and only valid for the operator that just passed the primary factor.
 */
/**
 * Only follow a post-auth `next` target that is a local path: must start
 * with '/', must not be scheme-relative ('//' or '/\') — anything else
 * (absolute URLs, schemes) is dropped to prevent open redirects.
 * (Mirrored in login/page.tsx and sign-up/page.tsx.)
 */
function safeNext(raw: FormDataEntryValue | null): string | null {
  const v = String(raw ?? '');
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !v.includes('://')
    ? v
    : null;
}

async function verify(formData: FormData): Promise<void> {
  'use server';
  const challenge = String(formData.get('challenge') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim();
  const next = safeNext(formData.get('next'));
  const keepNext = next ? `&next=${encodeURIComponent(next)}` : '';
  if (!challenge || !code) redirect(`/mfa-verify?error=missing${keepNext}`);

  let result: AuthResponse;
  try {
    result = await publicPost<AuthResponse>('/api/v1/tenant/auth/mfa-verify', {
      mfaChallengeToken: challenge,
      code,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      // Preserve the challenge (and `next`) so the user can retry without a
      // fresh sign-in.
      redirect(
        `/mfa-verify?challenge=${encodeURIComponent(challenge)}&error=${encodeURIComponent(err.code)}${keepNext}`,
      );
    }
    throw err;
  }

  await setSessionCookies({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
  if (next) redirect(`${next}${next.includes('?') ? '&' : '?'}e=login_mfa`);
  redirect('/applications?e=login_mfa');
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Authenticator code is required.',
  MFA_CODE_INVALID: 'That code didn\'t verify. Try the current 6-digit code or a backup code.',
  MFA_CHALLENGE_INVALID:
    'The challenge expired or was already used. Sign in again to start over.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL_ERROR: 'Something went wrong verifying that code. Please try again.',
};

export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const challenge =
    typeof params.challenge === 'string' ? params.challenge : '';
  // Only codes we have copy for render a banner — an unrecognized `?error=`
  // value shows nothing rather than an unexplained "something went wrong".
  const error = typeof params.error === 'string' ? ERROR_MESSAGES[params.error] : undefined;
  const next = typeof params.next === 'string' ? params.next : undefined;

  if (!challenge) redirect('/login');

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <form
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

        <input type="hidden" name="challenge" value={challenge} />
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
          <Link href="/login" className="hover:text-[var(--color-fg)]">
            Back to sign-in
          </Link>
        </div>
      </form>
    </main>
  );
}
