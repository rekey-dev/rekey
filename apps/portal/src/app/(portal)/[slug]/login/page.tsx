import * as React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getMfaChallenge, getPortalUser, getSignInEmail, getSignInLink } from '@/lib/session';
import { getPortalConfig, supportLink } from '@/lib/config';
import { signInAction, mfaVerifyAction, requestSignInLinkAction, signInWithLinkAction } from '@/lib/actions';
import { afterSignInPath, signInReturnPage } from '@/lib/sign-in-return';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';
import { ResendVerificationForm } from '@/components/resend-verification-form';
import { SocialSignInButtons } from '@/components/social-sign-in-buttons';
import { socialSignInProviders } from '@/lib/social-sign-in';
import { providerDisplayName, socialSignInErrorCopy } from '@/lib/social-sign-in-copy';
import {
  MFA_EXPIRED_COPY,
  PASSWORD_OFF_COPY,
  SIGN_IN_LINK_MISSING_COPY,
  VERIFICATION_SENT_COPY,
  mfaErrorCopy,
  parseRetryAfter,
  signInErrorCopy,
  signInLinkRequestErrorCopy,
  signInLinkSentCopy,
  verificationResendErrorCopy,
} from '@/lib/auth-error-copy';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';

function EmailField({ autoFocus, defaultValue }: { autoFocus: boolean; defaultValue: string | undefined }): React.JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-[var(--color-fg)]">Email</span>
      <input
        name="email"
        type="email"
        required
        autoFocus={autoFocus}
        autoComplete="email"
        defaultValue={defaultValue}
        placeholder="you@example.com"
        className={inputCls}
      />
    </label>
  );
}

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const returnTo = signInReturnPage(sp.return);
  if (await getPortalUser(slug)) redirect(afterSignInPath(slug, returnTo));
  const config = await getPortalConfig(slug);
  if (!config) notFound();

  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const reason = typeof sp.reason === 'string' ? sp.reason : undefined;
  const mfaStep = sp.step === 'mfa';
  const lastEmail = error ? await getSignInEmail() : undefined;
  const retryAfterSeconds = parseRetryAfter(sp.retry);
  const linkError = typeof sp.link_error === 'string' ? sp.link_error : undefined;
  const { password, magicLink, signup } = config.auth;
  const linkWaiting = sp.step === 'link' ? await getSignInLink() : null;

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
              inputMode="text"
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

  if (linkWaiting) {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Sign in</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">Finish signing in with the link from your email.</p>
        <form action={signInWithLinkAction.bind(null, slug)}>
          <SubmitButton pendingLabel="Signing in…" className="w-full">
            Sign in
          </SubmitButton>
        </form>
      </div>
    );
  }

  const resendError = typeof sp.resend_error === 'string' ? sp.resend_error : undefined;
  if (error === 'EMAIL_NOT_VERIFIED' || resendError) {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Sign in</h1>
        <Banner tone="error">
          {resendError ? verificationResendErrorCopy(resendError, retryAfterSeconds) : signInErrorCopy('EMAIL_NOT_VERIFIED')}
        </Banner>
        <ResendVerificationForm slug={slug} from="login" email={lastEmail} />
        <p className="text-sm text-[var(--color-muted-fg)]">
          <Link href={`/${slug}/login`} className="underline hover:text-[var(--color-fg)]">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  const support = supportLink(config.branding);
  const appName = config.branding.displayName || config.name;
  const returnField = returnTo && <input type="hidden" name="return" value={returnTo} />;
  const providers = await socialSignInProviders(slug);
  const socialError = typeof sp.social_error === 'string' ? sp.social_error : undefined;

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Sign in</h1>
      {reason === 'expired' && <Banner tone="info">Your session expired. Sign in again.</Banner>}
      {reason === 'mfa_expired' && <Banner tone="info">{MFA_EXPIRED_COPY}</Banner>}
      {reason === 'password_off' && <Banner tone="info">{PASSWORD_OFF_COPY}</Banner>}
      {reason === 'session_interrupted' && (
        <Banner tone="info">
          Your session was interrupted while it renewed, so it was signed out to keep your account safe. Sign in again
          to carry on.
        </Banner>
      )}
      {reason === 'reset' && (
        <Banner tone="success">Password updated. Sign in with your new password.</Banner>
      )}
      {sp.step === 'link' && <Banner tone="error">{SIGN_IN_LINK_MISSING_COPY}</Banner>}
      {sp.link === 'sent' && <Banner tone="success">{signInLinkSentCopy(signup)}</Banner>}
      {sp.resend === 'sent' && <Banner tone="success">{VERIFICATION_SENT_COPY}</Banner>}
      {linkError && <Banner tone="error">{signInLinkRequestErrorCopy(linkError, retryAfterSeconds)}</Banner>}
      {error && <Banner tone="error">{signInErrorCopy(error, retryAfterSeconds)}</Banner>}
      {socialError && (
        <Banner tone="error">{socialSignInErrorCopy(socialError, providerDisplayName(providers, sp.provider))}</Banner>
      )}
      {password && (
        <form action={signInAction.bind(null, slug)} className="space-y-3">
          {returnField}
          <EmailField autoFocus defaultValue={lastEmail} />
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
      )}
      {password && (
        <p className="text-sm text-[var(--color-muted-fg)]">
          <Link
            href={`/${slug}/forgot-password`}
            className="underline hover:text-[var(--color-fg)]"
          >
            Forgot password?
          </Link>
        </p>
      )}
      {magicLink && (
        <form
          action={requestSignInLinkAction.bind(null, slug)}
          className={password ? 'space-y-3 border-t border-[var(--color-border)] pt-5' : 'space-y-3'}
        >
          {returnField}
          {(password || signup) && (
            <p className="text-sm text-[var(--color-muted-fg)]">
              {password && 'Or sign in without a password. '}
              {signup
                ? 'We email you a link that signs you in, and creates your account if you are new.'
                : 'We email you a link.'}
            </p>
          )}
          <EmailField autoFocus={!password} defaultValue={lastEmail} />
          <SubmitButton pendingLabel="Sending…" variant={password ? 'secondary' : 'primary'} className="w-full">
            Email me a sign-in link
          </SubmitButton>
        </form>
      )}
      <SocialSignInButtons slug={slug} providers={providers} returnTo={returnTo} separated={password || magicLink} />
      {signup && (password || magicLink || providers.length > 0) && (
        <p className="text-sm text-[var(--color-muted-fg)]">
          New here?{' '}
          <Link
            href={`/${slug}/sign-up${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`}
            className="underline hover:text-[var(--color-fg)]"
          >
            Create an account
          </Link>
        </p>
      )}
      {!password && !magicLink && providers.length === 0 && (
        <div className="space-y-3 text-sm text-[var(--color-muted-fg)]">
          <p>Sign-in for this account happens in {appName} itself. Open {appName} and sign in there.</p>
          {support && (
            <p>
              <a href={support} className="underline hover:text-[var(--color-fg)]">
                Contact support
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
