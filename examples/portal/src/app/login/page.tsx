/**
 * Sign-in — email + password, or a magic link. Accounts are created in the
 * operator's own application (this portal manages billing for existing
 * customers; it deliberately has no sign-up).
 */

import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { signInAction, requestMagicLinkAction } from '@/lib/actions';
import { getSession, getAppName } from '@/lib/session';
import { Banner } from '@/components/banner';

const ERROR_COPY: Record<string, string> = {
  missing: 'Enter your email and password.',
  INVALID_CREDENTIALS: 'That email and password combination is not right.',
  MFA_REQUIRED:
    'This account has two-factor authentication enabled — portal sign-in does not support it yet. Manage billing from the main application.',
  AUTH_METHOD_DISABLED: 'Password sign-in is disabled for this application — use a magic link.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; changed?: string; next?: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session) redirect('/subscription');
  const params = await searchParams;
  const appName = await getAppName();

  const inputClass =
    'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--color-primary)]';

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{appName}</h1>
        <p className="text-sm text-[var(--color-muted-fg)]">
          Sign in to manage your subscription and billing.
        </p>
      </header>

      {params.changed && <Banner tone="success">Password changed — sign in again.</Banner>}
      {params.sent && (
        <Banner tone="success">If that email has an account, a sign-in link is on its way.</Banner>
      )}
      {params.error && (
        <Banner tone="error">{ERROR_COPY[params.error] ?? `Sign-in failed (${params.error}).`}</Banner>
      )}

      <form action={signInAction} className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        {params.next && <input type="hidden" name="next" value={params.next} />}
        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <input name="email" type="email" autoComplete="email" required className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
        >
          Sign in
        </button>
      </form>

      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p className="text-sm text-[var(--color-muted-fg)]">
          Or get a one-time sign-in link by email:
        </p>
        <form action={requestMagicLinkAction} className="flex gap-2">
          <input
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className={inputClass}
          />
          <button
            type="submit"
            className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-surface-muted)]"
          >
            Send link
          </button>
        </form>
      </div>
    </main>
  );
}
