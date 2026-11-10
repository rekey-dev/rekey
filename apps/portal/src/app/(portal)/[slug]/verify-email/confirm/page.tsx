import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getVerifyEmailLink } from '@/lib/session';
import { getPortalConfig } from '@/lib/config';
import { confirmEmailAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';
import { ResendVerificationForm } from '@/components/resend-verification-form';
import {
  EMAIL_CONFIRMED_COPY,
  VERIFICATION_LINK_MISSING_COPY,
  VERIFICATION_SENT_COPY,
  parseRetryAfter,
  verificationResendErrorCopy,
  verifyEmailErrorCopy,
} from '@/lib/auth-error-copy';

export default async function ConfirmEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  if (!(await getPortalConfig(slug))) notFound();
  const retryAfterSeconds = parseRetryAfter(sp.retry);
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const resendError = typeof sp.resend_error === 'string' ? sp.resend_error : undefined;

  if (sp.done === '1') {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Email address confirmed</h1>
        <Banner tone="success">{EMAIL_CONFIRMED_COPY}</Banner>
        <Link
          href={`/${slug}/login`}
          className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2 text-center text-sm font-medium text-[var(--color-primary-fg)]"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const waiting = !error && !resendError && sp.resend !== 'sent' ? await getVerifyEmailLink() : null;
  if (waiting) {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Confirm your email address</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">Finish confirming your email address with one click.</p>
        <form action={confirmEmailAction.bind(null, slug)}>
          <SubmitButton pendingLabel="Confirming…" className="w-full">
            Confirm email address
          </SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Confirm your email address</h1>
      {sp.resend === 'sent' ? (
        <Banner tone="success">{VERIFICATION_SENT_COPY}</Banner>
      ) : resendError ? (
        <Banner tone="error">{verificationResendErrorCopy(resendError, retryAfterSeconds)}</Banner>
      ) : (
        <Banner tone="error">
          {error ? verifyEmailErrorCopy(error, retryAfterSeconds) : VERIFICATION_LINK_MISSING_COPY}
        </Banner>
      )}
      {sp.resend !== 'sent' && <ResendVerificationForm slug={slug} from="link" />}
      <p className="text-sm text-[var(--color-muted-fg)]">
        <Link href={`/${slug}/login`} className="underline hover:text-[var(--color-fg)]">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
