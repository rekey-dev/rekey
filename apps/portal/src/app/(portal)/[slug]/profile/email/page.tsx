import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';
import { getAccessToken, getEmailChangeLink } from '@/lib/session';
import { confirmEmailChangeAction } from '@/lib/email-change-actions';
import { EMAIL_CHANGED_COPY, emailChangeErrorCopy } from '@/lib/profile-copy';
import { profilePath } from '@/lib/profile';
import { parseRetryAfter } from '@/lib/auth-error-copy';
import { Banner } from '@/components/banner';
import { PasswordField } from '@/components/password-field';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';

const linkCls = 'underline hover:text-[var(--color-fg)]';
const mutedCls = 'text-sm text-[var(--color-muted-fg)]';

/**
 * Where the email-change link lands, after `email-change-link/route.ts` moved
 * its token into a cookie. Signed in, one button confirms; signed out, the
 * account's password does.
 */
export default async function ConfirmEmailChangePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  if (!(await getPortalConfig(slug))) notFound();
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  if (sp.done === '1') {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Email address changed</h1>
        <Banner tone="success">{EMAIL_CHANGED_COPY}</Banner>
        <Link
          href={`/${slug}/login`}
          className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2 text-center text-sm font-medium text-[var(--color-primary-fg)]"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const [token, accessToken] = await Promise.all([getEmailChangeLink(), getAccessToken()]);
  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Confirm your new email address</h1>
      {error && <Banner tone="error">{emailChangeErrorCopy(error, parseRetryAfter(sp.retry))}</Banner>}
      {token ? (
        <form action={confirmEmailChangeAction.bind(null, slug)} className="space-y-3">
          {accessToken ? (
            <p className={mutedCls}>Confirm to make this the address your account uses. You are then signed out everywhere.</p>
          ) : (
            <>
              <p className={mutedCls}>
                Enter your password to confirm. No password? <Link href={`/${slug}/login`} className={linkCls}>Sign in</Link>{' '}
                first, then open the link in the email again.
              </p>
              <PasswordField name="password" label="Your password" autoComplete="current-password" />
            </>
          )}
          <SubmitButton pendingLabel="Confirming…" className="w-full">
            Confirm new address
          </SubmitButton>
        </form>
      ) : (
        !error && <Banner tone="error">{emailChangeErrorCopy('EMAIL_CHANGE_TOKEN_INVALID')}</Banner>
      )}
      <p className={mutedCls}>
        <Link href={profilePath(slug)} className={linkCls}>
          Back to your profile
        </Link>
      </p>
    </div>
  );
}
