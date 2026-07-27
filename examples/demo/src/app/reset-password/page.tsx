import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { rekey, RekeyError } from '@/lib/relipay';

async function reset(formData: FormData): Promise<void> {
  'use server';
  const token = String(formData.get('token') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!token || !newPassword) redirect('/reset-password?error=missing');

  try {
    await rekey.auth.resetPassword({ token, newPassword });
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/sign-in?reason=reset');
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'A token and a new password are required.',
  PASSWORD_RESET_TOKEN_INVALID: 'This reset link is invalid. Request a fresh one.',
  PASSWORD_RESET_TOKEN_USED: 'This reset link was already used. Request a fresh one.',
  PASSWORD_RESET_TOKEN_EXPIRED: 'This reset link expired. Request a fresh one.',
  PASSWORD_TOO_SHORT: 'Password must be at least 8 characters.',
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const error = typeof params.error === 'string' ? params.error : undefined;

  if (!token) {
    return (
      <main className="min-h-screen grid place-items-center px-6">
        <p className="text-sm text-neutral-500">
          No reset token in the URL. Start at{' '}
          <Link href="/forgot-password" className="underline">
            /forgot-password
          </Link>
          .
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <form action={reset} className="w-full max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Set a new password</h1>

        {error && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERROR_MESSAGES[error] ?? error}
          </p>
        )}

        <input type="hidden" name="token" value={token} />
        <input
          type="password"
          name="newPassword"
          aria-label="New password"
          required
          autoFocus
          autoComplete="new-password"
          minLength={8}
          placeholder="at least 8 characters"
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Set new password
        </button>
      </form>
    </main>
  );
}
