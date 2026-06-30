import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { publicPost } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';

async function request(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/forgot-password?error=missing');
  const result = await publicPost<{ delivered: boolean; resetToken: string | null }>(
    '/api/v1/tenant/auth/forgot-password',
    { email },
  );
  // Demo behavior: surface the token via querystring so the operator can
  // click through without an email integration. In a real deploy, your
  // mailer hands it to the user instead.
  if (result.resetToken) {
    redirect(`/forgot-password?sent=1&demoToken=${encodeURIComponent(result.resetToken)}`);
  }
  redirect('/forgot-password?sent=1');
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const sent = params.sent === '1';
  const demoToken = typeof params.demoToken === 'string' ? params.demoToken : null;
  const error = typeof params.error === 'string' ? params.error : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <form action={request} className="w-full max-w-md space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Reset password</h1>

        {error === 'missing' && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">Email required.</p>
        )}
        {sent && (
          <div className="rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950 px-3 py-2 text-sm space-y-2">
            <p className="text-emerald-800 dark:text-emerald-300">If that email is registered, a reset link is on its way.</p>
            {demoToken && (
              <p className="text-xs">
                <span className="font-medium">Demo:</span>{' '}
                <Link href={`/reset-password?token=${encodeURIComponent(demoToken)}`} className="underline">
                  Open reset page
                </Link>
              </p>
            )}
          </div>
        )}

        <input type="email" name="email" required autoFocus autoComplete="email" placeholder="you@example.com"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm" />
        <SubmitButton
          pendingLabel="Sending link…"
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Send reset link
        </SubmitButton>

        <p className="text-sm text-[var(--color-muted-fg)] text-center pt-2 border-t border-[var(--color-border)]">
          <Link href="/login" className="underline">Back to sign in</Link>
        </p>
      </form>
    </main>
  );
}
