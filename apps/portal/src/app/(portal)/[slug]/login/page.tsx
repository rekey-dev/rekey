import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMfaChallenge, getPortalUser } from '@/lib/session';
import { signInAction, mfaVerifyAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';
import { MFA_EXPIRED_COPY, mfaErrorCopy, parseRetryAfter, signInErrorCopy } from '@/lib/auth-error-copy';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  // Already signed in → straight to the dashboard.
  if (await getPortalUser(slug)) redirect(`/${slug}`);

  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const reason = typeof sp.reason === 'string' ? sp.reason : undefined;
  const mfaStep = sp.step === 'mfa';
  const lastEmail = typeof sp.email === 'string' ? sp.email : undefined;
  const retryAfterSeconds = parseRetryAfter(sp.retry);

  // MFA code step: sign-in succeeded, account is MFA-enrolled. The challenge
  // itself stays in its httpOnly cookie; without it there is nothing to verify.
  if (mfaStep) {
    if (!(await getMfaChallenge())) redirect(`/${slug}/login?reason=mfa_expired`);
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Two-factor authentication</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">
          Enter the 6-digit code from your authenticator app, or a saved backup code.
        </p>
        {error && <Banner tone="error">{mfaErrorCopy(error, retryAfterSeconds)}</Banner>}
        <form action={mfaVerifyAction.bind(null, slug)} className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">Code</span>
            <input
              name="code"
              type="text"
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className={inputCls}
            />
          </label>
          <SubmitButton pendingLabel="Verifying…" className="w-full">
            Verify
          </SubmitButton>
        </form>
        <p className="text-sm text-[var(--color-muted-fg)]">
          <Link href={`/${slug}/login`} className="underline hover:text-[var(--color-fg)]">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Sign in</h1>
      {reason === 'expired' && <Banner tone="info">Your session expired. Sign in again.</Banner>}
      {reason === 'mfa_expired' && <Banner tone="info">{MFA_EXPIRED_COPY}</Banner>}
      {reason === 'session_interrupted' && (
        <Banner tone="info">
          Your session was interrupted while it renewed, so it was signed out to keep your account safe. Sign in again
          to carry on.
        </Banner>
      )}
      {reason === 'reset' && (
        <Banner tone="success">Password updated. Sign in with your new password.</Banner>
      )}
      {error && <Banner tone="error">{signInErrorCopy(error, retryAfterSeconds)}</Banner>}
      <form action={signInAction.bind(null, slug)} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-fg)]">Email</span>
          <input
            name="email"
            type="email"
            required
            autoFocus
            autoComplete="email"
            defaultValue={lastEmail}
            placeholder="you@example.com"
            className={inputCls}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-fg)]">Password</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="Password"
            className={inputCls}
          />
        </label>
        <SubmitButton pendingLabel="Signing in…" className="w-full">
          Sign in
        </SubmitButton>
      </form>
      <p className="text-sm text-[var(--color-muted-fg)]">
        <Link
          href={`/${slug}/forgot-password`}
          className="underline hover:text-[var(--color-fg)]"
        >
          Forgot password?
        </Link>
      </p>
    </div>
  );
}
