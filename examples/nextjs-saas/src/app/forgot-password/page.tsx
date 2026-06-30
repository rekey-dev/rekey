import * as React from 'react';
import Link from 'next/link';
import { requestPasswordResetAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { CopyField } from '@/components/copy-field';

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const sent = params.sent === '1';
  const token = typeof params.token === 'string' ? params.token : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6 py-12">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <Link href="/" className="font-bold text-relipay-700 dark:text-relipay-500">
            ReliPay SaaS
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">Reset your password</h1>
        </div>

        <Banner error={error} status={sent ? 'If that email exists, a reset link has been sent.' : undefined} />

        {sent && token && (
          <div className="card space-y-2">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              No email transport is configured on this application, so the reset link is shown here
              (a real app would email it):
            </p>
            <CopyField label="Reset link" value={`/reset-password?token=${encodeURIComponent(token)}`} />
            <Link href={`/reset-password?token=${encodeURIComponent(token)}`} className="btn w-full">
              Continue to reset
            </Link>
          </div>
        )}

        {!sent && (
          <form action={requestPasswordResetAction} className="card space-y-3">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoFocus autoComplete="email" placeholder="you@example.com" className="field" />
            </div>
            <button type="submit" className="btn w-full">Send reset link</button>
          </form>
        )}

        <p className="text-center text-sm text-neutral-500">
          <Link href="/login" className="underline">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
