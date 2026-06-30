import * as React from 'react';
import { redirect } from 'next/navigation';
import { getPortalUser } from '@/lib/session';
import { signInAction } from '@/lib/actions';
import { Banner } from '@/components/banner';

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  // Already signed in → straight to the dashboard.
  if (await getPortalUser(slug)) redirect(`/${slug}`);

  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const reason = typeof sp.reason === 'string' ? sp.reason : undefined;

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Sign in</h1>
      {reason === 'expired' && <Banner tone="info">Your session expired — sign in again.</Banner>}
      {error === 'MFA_REQUIRED' && (
        <Banner tone="error">This account uses two-factor auth, which isn&apos;t supported here yet.</Banner>
      )}
      {error && error !== 'MFA_REQUIRED' && (
        <Banner tone="error">Could not sign in. Check your email and password and try again.</Banner>
      )}
      <form action={signInAction.bind(null, slug)} className="space-y-3">
        <input
          name="email"
          type="email"
          required
          autoFocus
          placeholder="you@example.com"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
        <input
          name="password"
          type="password"
          required
          placeholder="Password"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
