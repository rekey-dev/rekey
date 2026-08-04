import * as React from 'react';
import Link from 'next/link';
import { forgotPasswordAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';

export default async function ForgotPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const sent = sp.sent === '1';
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Reset your password</h1>
      {sent ? (
        <>
          <Banner tone="success">
            If an account exists for that email, a reset link is on its way. Check your inbox.
          </Banner>
          <p className="text-sm text-[var(--color-muted-fg)]">
            <Link href={`/${slug}/login`} className="underline hover:text-[var(--color-fg)]">
              Back to sign in
            </Link>
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--color-muted-fg)]">
            Enter your account email and we&apos;ll send you a link to set a new password.
          </p>
          {error && <Banner tone="error">Enter your email address to continue.</Banner>}
          <form action={forgotPasswordAction.bind(null, slug)} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-[var(--color-fg)]">Email</span>
              <input
                name="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              />
            </label>
            <SubmitButton pendingLabel="Sending…" className="w-full">
              Send reset link
            </SubmitButton>
          </form>
          <p className="text-sm text-[var(--color-muted-fg)]">
            <Link href={`/${slug}/login`} className="underline hover:text-[var(--color-fg)]">
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
