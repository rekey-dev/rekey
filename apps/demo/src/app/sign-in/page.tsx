import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { relipay, RelipayError, setSessionCookies } from '@/lib/relipay';

async function signIn(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) {
    redirect('/sign-in?error=missing');
  }

  try {
    const result = await relipay.auth.signIn({ email, password });
    if (result.mfaRequired) {
      // This demo doesn't implement the MFA second factor; surface a clear message.
      redirect('/sign-in?error=MFA_REQUIRED');
    }
    await setSessionCookies({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    if (err instanceof RelipayError) {
      redirect(`/sign-in?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/dashboard');
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Email and password are required.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  MFA_REQUIRED: 'This account has MFA enabled — the demo does not implement the second-factor step.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const reason = typeof params.reason === 'string' ? params.reason : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <form action={signIn} className="w-full max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Sign in</h1>

        {reason === 'expired' && (
          <p className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            Your session expired. Please sign in again.
          </p>
        )}
        {error && (
          <p role="alert" className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERROR_MESSAGES[error] ?? error}
          </p>
        )}

        <input
          type="email"
          name="email"
          aria-label="Email"
          required
          autoFocus
          autoComplete="email"
          placeholder="you@example.com"
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        <input
          type="password"
          name="password"
          aria-label="Password"
          required
          autoComplete="current-password"
          placeholder="password"
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Sign in
        </button>

        <p className="text-sm text-neutral-500 flex justify-between">
          <Link href="/sign-up" className="underline">
            Create account
          </Link>
          <Link href="/forgot-password" className="underline">
            Forgot password?
          </Link>
        </p>
      </form>
    </main>
  );
}
