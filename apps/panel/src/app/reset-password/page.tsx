import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { publicPost, PanelApiError } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';

async function reset(formData: FormData): Promise<void> {
  'use server';
  const token = String(formData.get('token') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!token || !newPassword) redirect('/reset-password?error=missing');
  try {
    await publicPost<{ ok: true }>('/api/v1/tenant/auth/reset-password', { token, newPassword });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/login?reason=reset');
}

const ERR: Record<string, string> = {
  missing: 'Token + new password required.',
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
        <p className="text-sm text-neutral-600 dark:text-neutral-500">No token in URL — start at <Link href="/forgot-password" className="underline">forgot password</Link>.</p>
      </main>
    );
  }
  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <form action={reset} className="w-full max-w-md space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Set new password</h1>
        {error && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">{ERR[error] ?? error}</p>
        )}
        <input type="hidden" name="token" value={token} />
        <input type="password" name="newPassword" required autoFocus minLength={8} placeholder="at least 8 characters"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm" />
        <SubmitButton pendingLabel="Saving password…" className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed">
          Set new password
        </SubmitButton>
      </form>
    </main>
  );
}
