import * as React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { getPortalUser, getSignInEmail } from '@/lib/session';
import { getPortalConfig } from '@/lib/config';
import { requestSignInLinkAction } from '@/lib/actions';
import { signUpAction } from '@/lib/sign-up-actions';
import { afterSignInPath, signInReturnPage } from '@/lib/sign-in-return';
import { VERIFICATION_SENT_COPY, parseRetryAfter, verificationResendErrorCopy } from '@/lib/auth-error-copy';
import { SIGN_UP_BY_LINK_COPY, SIGN_UP_SENT_COPY, signUpErrorCopy } from '@/lib/sign-up-copy';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';
import { ChoosePasswordField } from '@/components/choose-password-field';
import { FocusOnArrival } from '@/components/focus-on-arrival';
import { ResendVerificationForm } from '@/components/resend-verification-form';
import { SignUpAgreement } from '@/components/sign-up-agreement';
import { SignUpHoneypot } from '@/components/sign-up-honeypot';
import { SocialSignInButtons } from '@/components/social-sign-in-buttons';
import { socialSignInProviders } from '@/lib/social-sign-in';

/** The lowest minimum any application can set; a longer one is refused by the API and explained. */
const PASSWORD_FLOOR = AuthConfigSchema.innerType().shape.passwordMinLength.removeDefault().minValue ?? 8;

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const mutedCls = 'text-sm text-[var(--color-muted-fg)]';
const linkCls = 'underline hover:text-[var(--color-fg)]';

export default async function SignUpPage({
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
  const { password, magicLink, signup } = config.auth;
  const loginHref = returnTo ? `/${slug}/login?return=${encodeURIComponent(returnTo)}` : `/${slug}/login`;
  const providers = signup ? await socialSignInProviders(slug) : [];
  if (!signup || (!password && !magicLink && providers.length === 0)) redirect(loginHref);

  const retryAfterSeconds = parseRetryAfter(sp.retry);
  const lastEmail = await getSignInEmail();
  const resendError = typeof sp.resend_error === 'string' ? sp.resend_error : undefined;
  const signInLink = (
    <p className={mutedCls}>
      <Link href={loginHref} className={linkCls}>
        Back to sign in
      </Link>
    </p>
  );

  if (sp.sent === '1' || sp.resend === 'sent' || resendError) {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Check your inbox</h1>
        {resendError ? (
          <FocusOnArrival>
            <Banner tone="error">{verificationResendErrorCopy(resendError, retryAfterSeconds)}</Banner>
          </FocusOnArrival>
        ) : (
          <Banner tone="success">{sp.resend === 'sent' ? VERIFICATION_SENT_COPY : SIGN_UP_SENT_COPY}</Banner>
        )}
        <p className={mutedCls}>No email after a few minutes? Check your spam folder, or send a new link.</p>
        <ResendVerificationForm slug={slug} from="sign-up" email={lastEmail} />
        {signInLink}
      </div>
    );
  }

  const error = typeof sp.error === 'string' ? signUpErrorCopy(sp.error, retryAfterSeconds) : null;
  const emailError = error?.field === 'email' ? error : null;
  const formError = error && error.field === null ? error : null;
  const emailErrorId = 'sign-up-email-error';
  const returnField = returnTo && <input type="hidden" name="return" value={returnTo} />;
  const emailField = (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-[var(--color-fg)]">Email</span>
        <input
          name="email"
          type="email"
          required
          autoFocus={!formError && error?.field !== 'password'}
          autoComplete="email"
          defaultValue={error ? lastEmail : undefined}
          placeholder="you@example.com"
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? emailErrorId : undefined}
          className={inputCls}
        />
      </label>
      {emailError && (
        <p id={emailErrorId} className="text-sm text-[var(--color-danger)]">
          {emailError.message}
          {emailError.offerSignIn && (
            <>
              {' '}
              <Link href={loginHref} className={linkCls}>
                Go to sign in
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Create an account</h1>
      {formError && (
        <FocusOnArrival>
          <Banner tone="error">
            {formError.message}
            {formError.offerSignIn && (
              <>
                {' '}
                <Link href={loginHref} className={linkCls}>
                  Go to sign in
                </Link>
              </>
            )}
          </Banner>
        </FocusOnArrival>
      )}
      {password ? (
        <form action={signUpAction.bind(null, slug)} className="space-y-3">
          {returnField}
          <SignUpHoneypot />
          {emailField}
          <ChoosePasswordField
            minLength={PASSWORD_FLOOR}
            name="password"
            label="Password"
            autoFocus={false}
            error={error?.field === 'password' ? error.message : undefined}
          />
          <SubmitButton pendingLabel="Creating account…" className="w-full">
            Create account
          </SubmitButton>
          <SignUpAgreement branding={config.branding} />
        </form>
      ) : magicLink ? (
        <form action={requestSignInLinkAction.bind(null, slug)} className="space-y-3">
          {returnField}
          <p className={mutedCls}>{SIGN_UP_BY_LINK_COPY}</p>
          {emailField}
          <SubmitButton pendingLabel="Sending…" className="w-full">
            Email me a link
          </SubmitButton>
          <SignUpAgreement branding={config.branding} />
        </form>
      ) : null}
      <SocialSignInButtons slug={slug} providers={providers} returnTo={returnTo} separated={password || magicLink} />
      {!password && !magicLink && <SignUpAgreement branding={config.branding} />}
      <p className={mutedCls}>
        Already have an account?{' '}
        <Link href={loginHref} className={linkCls}>
          Sign in
        </Link>
      </p>
    </div>
  );
}
