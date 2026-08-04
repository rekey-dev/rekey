import * as React from 'react';
import Link from 'next/link';
import { resetPasswordAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';

const ERR: Record<string, string> = {
  PASSWORD_RESET_TOKEN_INVALID:
    'This reset link is invalid or was already used. Request a new one.',
  PASSWORD_RESET_TOKEN_EXPIRED: 'This reset link expired. Request a new one.',
  PASSWORD_TOO_WEAK: 'That password is too weak — try a longer one.',
  PASSWORD_BREACHED:
    'That password appears in a known data breach — choose a different one.',
};

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === 'string' ? sp.token : '';
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  if (!token) {
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
        <Banner tone="error">{ERR[error] ?? 'Something went wrong. Please try again.'}</Banner>
      )}
      <form action={resetPasswordAction.bind(null, slug)} className="space-y-3">
        <input type="hidden" name="token" value={token} />
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-fg)]">New password</span>
          <input
            name="newPassword"
            type="password"
            required
            autoFocus
            autoComplete="new-password"
            placeholder="New password"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
        </label>
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
