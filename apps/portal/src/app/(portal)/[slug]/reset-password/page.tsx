import * as React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { getPortalConfig } from '@/lib/config';
import { getResetPasswordLink } from '@/lib/session';
import { resetPasswordAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { ChoosePasswordField } from '@/components/choose-password-field';
import { SubmitButton } from '@/components/submit-button';
import { parseRetryAfter, resetPasswordErrorCopy } from '@/lib/auth-error-copy';

/**
 * The lowest minimum any application can set. The portal config does not say
 * which one this application chose, so a longer one is refused by the API and
 * explained by the error copy.
 */
const PASSWORD_FLOOR = AuthConfigSchema.innerType().shape.passwordMinLength.removeDefault().minValue ?? 8;

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const config = await getPortalConfig(slug);
  if (!config) notFound();
  if (!config.auth.password) {
    redirect(`/${slug}/login${error === 'AUTH_METHOD_DISABLED' ? '?reason=password_off' : ''}`);
  }

  if (!(await getResetPasswordLink())) {
    return (
      <div className="mx-auto max-w-sm space-y-5 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">Set a new password</h1>
        <Banner tone="error">
          This page needs the link from your reset email. Follow the link in the email, or
          request a new one.
        </Banner>
        <p className="text-sm text-[var(--color-muted-fg)]">
          <Link
            href={`/${slug}/forgot-password`}
            className="underline hover:text-[var(--color-fg)]"
          >
            Request a reset link
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Set a new password</h1>
      {error && (
        <Banner tone="error">{resetPasswordErrorCopy(error, parseRetryAfter(sp.retry))}</Banner>
      )}
      <form action={resetPasswordAction.bind(null, slug)} className="space-y-3">
        <ChoosePasswordField minLength={PASSWORD_FLOOR} />
        <SubmitButton pendingLabel="Updating…" className="w-full">
          Update password
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
