import * as React from 'react';
import Link from 'next/link';
import { resetPasswordAction } from '@/lib/actions';
import { Banner } from '@/components/banner';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const token = typeof params.token === 'string' ? params.token : '';

  return (
    <main className="min-h-screen grid place-items-center px-6 py-12">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <Link href="/" className="font-bold text-relipay-700 dark:text-relipay-500">
            ReliPay SaaS
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">Choose a new password</h1>
        </div>

        <Banner error={error} />

        {token ? (
          <form action={resetPasswordAction} className="card space-y-3">
            <input type="hidden" name="token" value={token} />
            <div>
              <label className="label" htmlFor="password">New password</label>
              <input id="password" name="password" type="password" required autoFocus autoComplete="new-password" placeholder="New password" className="field" />
            </div>
            <button type="submit" className="btn w-full">Update password</button>
          </form>
        ) : (
          <div className="card text-sm text-neutral-600 dark:text-neutral-400">
            This page needs a reset token. Start from{' '}
            <Link href="/forgot-password" className="underline">forgot password</Link>.
          </div>
        )}
      </div>
    </main>
  );
}
