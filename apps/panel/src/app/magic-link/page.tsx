import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { publicPost, PanelApiError } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/AuthCard';
import { Banner } from '@/components/Banner';

export const metadata: Metadata = { title: 'Email me a sign-in link · ReliPay' };

async function request(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/magic-link?error=missing');
  // Enumeration-safe: the API returns the same shape regardless of whether the
  // email maps to an operator. ReliPay doesn't send operator email, so the raw
  // token comes back for the caller to forward (mirrors forgot-password).
  let result: { delivered: boolean; token: string | null };
  try {
    result = await publicPost<{ delivered: boolean; token: string | null }>(
      '/api/v1/tenant/auth/magic-link/request',
      { email },
    );
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/magic-link?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  if (result.token) {
    redirect(`/magic-link?sent=1&demoToken=${encodeURIComponent(result.token)}`);
  }
  redirect('/magic-link?sent=1');
}

const ERR: Record<string, string> = {
  missing: 'Enter the email address on your account.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL_ERROR: 'Something went wrong sending the link. Please try again.',
};

export default async function MagicLinkPage({
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
    <AuthCard
      action={request}
      title="Email me a sign-in link"
      subtitle="We'll send a one-time link that signs you in without a password. It expires in 15 minutes."
      spacing="sm"
    >
        {error && <Banner tone="error">{error}</Banner>}
        {sent && (
          <Banner tone="success" className="space-y-2">
            <p>If that email is registered, a sign-in link is on its way.</p>
            {demoToken && (
              <p className="text-xs">
                <span className="font-medium">Demo:</span>{' '}
                <Link href={`/login/magic-link?token=${encodeURIComponent(demoToken)}`} className="underline">
                  Sign in with this link
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
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Email me a sign-in link
        </SubmitButton>

        <p className="text-sm text-[var(--color-muted-fg)] text-center pt-2 border-t border-[var(--color-border)]">
          <Link href="/login" className="underline">Back to sign in</Link>
        </p>
    </AuthCard>
  );
}
