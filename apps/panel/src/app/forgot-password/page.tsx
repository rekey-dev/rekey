import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { errorQuery, publicPost, PanelApiError } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/AuthCard';
import { Banner } from '@/components/Banner';

export const metadata: Metadata = { title: 'Reset your password · Rekey' };

async function request(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/forgot-password?error=missing');
  let result: { delivered: boolean; resetToken: string | null };
  try {
    result = await publicPost<{ delivered: boolean; resetToken: string | null }>(
      '/api/v1/tenant/auth/forgot-password',
      { email },
    );
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/forgot-password?${await errorQuery(err)}`);
    }
    throw err;
  }
  // Demo behavior: surface the token via querystring so the operator can
  // click through without an email integration. In a real deploy, your
  // mailer hands it to the user instead.
  if (result.resetToken) {
    redirect(`/forgot-password?sent=1&demoToken=${encodeURIComponent(result.resetToken)}`);
  }
  redirect('/forgot-password?sent=1');
}

const ERR: Record<string, string> = {
  missing: 'Enter the email address on your account.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL_ERROR: 'Something went wrong sending the link. Please try again.',
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const sent = params.sent === '1';
  const demoToken = typeof params.demoToken === 'string' ? params.demoToken : null;
  // Only codes we have copy for render a banner — an unrecognized `?error=`
  // value shows nothing rather than an unexplained "something went wrong".
  const error = typeof params.error === 'string' ? ERR[params.error] : undefined;

  return (
    <AuthCard action={request} title="Reset password" spacing="sm">
        {error && <Banner tone="error">{error}</Banner>}
        {sent && (
          <Banner tone="success" className="space-y-2">
            <p>If that email is registered, a reset link is on its way.</p>
            {demoToken && (
              <p className="text-xs">
                <span className="font-medium">Demo:</span>{' '}
                <Link href={`/reset-password?token=${encodeURIComponent(demoToken)}`} className="underline">
                  Open reset page
                </Link>
              </p>
            )}
          </Banner>
        )}

        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Email</span>
          <input type="email" name="email" required autoFocus autoComplete="email" placeholder="you@example.com"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm" />
        </label>
        <SubmitButton
          pendingLabel="Sending link…"
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Send reset link
        </SubmitButton>

        <p className="text-sm text-[var(--color-muted-fg)] text-center pt-2 border-t border-[var(--color-border)]">
          <Link href="/login" className="underline">Back to sign in</Link>
        </p>
    </AuthCard>
  );
}
