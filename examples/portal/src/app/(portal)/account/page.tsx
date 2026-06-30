/**
 * Account — email + verification state, password change (revokes all other
 * sessions server-side; the action then signs this session out too), and
 * sign out (in the header).
 */

import type { ReactNode } from 'react';
import { requireSession } from '@/lib/session';
import { changePasswordAction, signOutAction } from '@/lib/actions';
import { formatDate } from '@/lib/portal';
import { Banner } from '@/components/banner';

const ERROR_COPY: Record<string, string> = {
  missing: 'Fill in both password fields.',
  INVALID_CREDENTIALS: 'Your current password is not right.',
  PASSWORD_TOO_SHORT: 'The new password is too short.',
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactNode> {
  const session = await requireSession();
  const params = await searchParams;

  const inputClass =
    'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--color-primary)]';

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Account</h1>

      {params.error && (
        <Banner tone="error">{ERROR_COPY[params.error] ?? `Update failed (${params.error}).`}</Banner>
      )}

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <h2 className="border-b border-[var(--color-border)] p-5 text-base font-semibold">Profile</h2>
        <dl className="grid grid-cols-1 gap-4 p-5 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[var(--color-muted-fg)]">Email</dt>
            <dd className="font-medium">
              {session.user.email}
              {!session.user.emailVerified && (
                <span className="ml-2 text-xs text-amber-700">unverified</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-muted-fg)]">Customer since</dt>
            <dd className="font-medium">{formatDate(session.user.createdAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <h2 className="border-b border-[var(--color-border)] p-5 text-base font-semibold">
          Change password
        </h2>
        <form action={changePasswordAction} className="space-y-3 p-5">
          <label className="block max-w-sm space-y-1">
            <span className="text-sm font-medium">Current password</span>
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
            />
          </label>
          <label className="block max-w-sm space-y-1">
            <span className="text-sm font-medium">New password</span>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              className={inputClass}
            />
          </label>
          <p className="text-xs text-[var(--color-muted-fg)]">
            Changing your password signs you out everywhere, including here.
          </p>
          <button
            type="submit"
            className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
          >
            Change password
          </button>
        </form>
      </section>

      <section className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="text-sm text-[var(--color-muted-fg)]">Done here?</p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-surface-muted)]"
          >
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}
