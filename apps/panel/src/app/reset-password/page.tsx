import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { publicPost, PanelApiError } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/AuthCard';
import { Banner } from '@/components/Banner';
import { PasswordConfirmFields } from '@/components/PasswordConfirmFields';

export const metadata: Metadata = { title: 'Set a new password · Rekey' };

async function reset(formData: FormData): Promise<void> {
  'use server';
  const token = String(formData.get('token') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');
  if (!token || !newPassword) redirect('/reset-password?error=missing');
  // Re-checked server-side: the client field disables submit on mismatch, but
  // that's a convenience, not a guarantee.
  if (newPassword !== confirmPassword) {
    redirect(`/reset-password?token=${encodeURIComponent(token)}&error=mismatch`);
  }
  try {
    await publicPost<{ ok: true }>('/api/v1/tenant/auth/reset-password', { token, newPassword });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/login?reason=reset');
}

const ERR: Record<string, string> = {
  missing: 'Enter a new password to continue.',
  mismatch: 'Those two passwords don’t match. Type the same one in both fields.',
  PASSWORD_RESET_TOKEN_INVALID: 'This reset link is invalid. Request a fresh one.',
  PASSWORD_RESET_TOKEN_USED: 'This reset link was already used. Request a fresh one.',
  PASSWORD_RESET_TOKEN_EXPIRED: 'This reset link expired. Request a fresh one.',
  PASSWORD_TOO_SHORT: 'Password must be at least 8 characters.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL_ERROR: 'Something went wrong saving your password. Please try again.',
};

const INPUT_BASE =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  // Only a code we have copy for renders a banner. An unrecognized `?error=`
  // value shows nothing, rather than an unexplained "something went wrong"
  // anyone could paint by editing the URL.
  const error = typeof params.error === 'string' ? ERR[params.error] : undefined;
  if (!token) {
    return (
      <AuthCard title="Set a new password" spacing="sm">
        <p className="text-sm text-[var(--color-muted-fg)]">
          To set a new password you need the link from your password-reset email. Open that
          link, or ask for a new one.
        </p>
        <Link
          href="/forgot-password"
          className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          Email me a reset link
        </Link>
        <p className="text-sm text-[var(--color-muted-fg)] text-center pt-2 border-t border-[var(--color-border)]">
          <Link href="/login" className="underline hover:text-[var(--color-fg)]">
            Back to sign in
          </Link>
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard action={reset} title="Set new password" spacing="sm">
        {error && <Banner tone="error">{error}</Banner>}
        <input type="hidden" name="token" value={token} />
        {/* The reset token doesn't reveal the account email server-side, so we
            can't offer a hidden autoComplete="username" field here without an
            API change — password managers fall back to prompting. */}
        <PasswordConfirmFields inputClassName={INPUT_BASE} />
        <SubmitButton pendingLabel="Saving password…" className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed">
          Set new password
        </SubmitButton>

        <p className="text-sm text-[var(--color-muted-fg)] text-center pt-2 border-t border-[var(--color-border)]">
          <Link href="/login" className="underline">Back to sign in</Link>
        </p>
    </AuthCard>
  );
}
