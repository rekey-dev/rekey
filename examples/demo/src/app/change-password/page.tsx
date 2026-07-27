import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { rekey, RekeyError, getAccessToken } from '@/lib/relipay';

async function change(formData: FormData): Promise<void> {
  'use server';
  const accessToken = await getAccessToken();
  if (!accessToken) redirect('/sign-in');

  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!currentPassword || !newPassword) redirect('/change-password?error=missing');

  try {
    await rekey.auth.changePassword(accessToken, { currentPassword, newPassword });
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/change-password?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/dashboard?changed=1');
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Both fields are required.',
  INVALID_CREDENTIALS: 'Current password is incorrect.',
  PASSWORD_TOO_SHORT: 'New password must be at least 8 characters.',
};

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  // Make sure the session is valid before showing the form. requireUser
  // will redirect to /sign-in if not.
  await requireUser();

  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <form action={change} className="w-full max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Change password</h1>

        {error && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERROR_MESSAGES[error] ?? error}
          </p>
        )}

        <input
          type="password"
          name="currentPassword"
          aria-label="Current password"
          required
          autoComplete="current-password"
          placeholder="current password"
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        <input
          type="password"
          name="newPassword"
          aria-label="New password"
          required
          autoComplete="new-password"
          minLength={8}
          placeholder="new password (8+ chars)"
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Change password
        </button>

        <p className="text-sm text-neutral-500">
          <Link href="/dashboard" className="underline">
            Back to dashboard
          </Link>
        </p>
      </form>
    </main>
  );
}
