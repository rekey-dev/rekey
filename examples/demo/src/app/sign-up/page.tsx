import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { rekey, RekeyError, setSessionCookies } from '@/lib/relipay';

async function signUp(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) {
    redirect('/sign-up?error=missing');
  }

  try {
    const result = await rekey.auth.signUp({ email, password });
    await setSessionCookies({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/sign-up?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/dashboard');
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Email and password are required.',
  EMAIL_ALREADY_EXISTS: 'That email is already registered. Try signing in.',
  PASSWORD_TOO_SHORT: 'Password must be at least 8 characters.',
  AUTH_METHOD_DISABLED: 'Password sign-up is not enabled for this application.',
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <form action={signUp} className="w-full max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Create account</h1>

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
          autoComplete="new-password"
          minLength={8}
          placeholder="at least 8 characters"
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Sign up
        </button>

        <p className="text-sm text-neutral-500">
          Already have an account?{' '}
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
