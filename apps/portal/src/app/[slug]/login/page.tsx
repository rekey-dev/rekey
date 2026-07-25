import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPortalUser } from '@/lib/session';
import { signInAction, mfaVerifyAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { Button } from '@/components/button';

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
  const mfaChallenge = typeof sp.mfa === 'string' ? sp.mfa : undefined;

  // ---- MFA code step: sign-in succeeded, account is MFA-enrolled ----
  if (mfaChallenge) {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Two-factor authentication</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">
          Enter the 6-digit code from your authenticator app, or a saved backup code.
        </p>
        {error && (
          <Banner tone="error">
            {error === 'MFA_CHALLENGE_INVALID'
              ? 'This sign-in attempt expired. Start over and sign in again.'
              : 'That code didn’t verify. Try the current code from your app.'}
          </Banner>
        )}
        <form action={mfaVerifyAction.bind(null, slug)} className="space-y-3">
          <input type="hidden" name="challenge" value={mfaChallenge} />
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
          <Button type="submit" className="w-full">
            Verify
          </Button>
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
      {reason === 'expired' && <Banner tone="info">Your session expired — sign in again.</Banner>}
      {reason === 'reset' && (
        <Banner tone="success">Password updated. Sign in with your new password.</Banner>
      )}
      {error && (
        <Banner tone="error">Could not sign in. Check your email and password and try again.</Banner>
      )}
      <form action={signInAction.bind(null, slug)} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-fg)]">Email</span>
          <input
            name="email"
            type="email"
            required
            autoFocus
            autoComplete="email"
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
        <Button type="submit" className="w-full">
          Sign in
        </Button>
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
