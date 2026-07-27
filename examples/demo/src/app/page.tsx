import * as React from 'react';
import Link from 'next/link';
import { getAccessToken } from '@/lib/relipay';

export default async function HomePage(): Promise<React.JSX.Element> {
  const signedIn = (await getAccessToken()) !== null;

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="w-full max-w-lg space-y-6 text-center">
        <h1 className="text-3xl font-semibold">Rekey Demo</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Reference Next.js app demonstrating <code>@rekey.dev/node</code> end-to-end:
          sign-up, sign-in, refresh, password reset, and change-password.
        </p>

        {signedIn ? (
          <div className="space-y-2">
            <Link
              href="/dashboard"
              className="inline-block rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Go to dashboard →
            </Link>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Sign up
            </Link>
            <Link
              href="/sign-in"
              className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            >
              Sign in
            </Link>
          </div>
        )}

        <p className="text-xs text-neutral-500 pt-4">
          API: <code>{process.env.RELIPAY_URL}</code>
        </p>
      </div>
    </main>
  );
}
