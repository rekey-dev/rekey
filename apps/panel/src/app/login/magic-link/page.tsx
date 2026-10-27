import * as React from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from '@/components/Link';
import { AuthCard } from '@/components/AuthCard';
import { SubmitButton } from '@/components/SubmitButton';
import { continueMagicLinkSignIn } from './actions';

export const metadata: Metadata = { title: 'Continue signing in · Rekey' };

/**
 * Where the emailed sign-in link lands (/login/magic-link?token=…). Opening
 * the link spends nothing: the token is exchanged only when the operator
 * presses the button, see {@link continueMagicLinkSignIn}.
 */
export default async function MagicLinkLandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  if (!token) redirect('/login?error=magic_link_missing');

  return (
    <AuthCard
      title="Continue signing in"
      subtitle="Only continue if you asked for this sign-in link yourself."
      action={continueMagicLinkSignIn}
    >
      <input type="hidden" hidden name="token" value={token} />
      <SubmitButton
        pendingLabel="Signing in…"
        className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        Continue signing in
      </SubmitButton>
      <div className="flex items-center justify-end text-sm text-[var(--color-muted-fg)] pt-2 border-t border-[var(--color-border)]">
        <Link href="/login" className="hover:text-[var(--color-fg)]">
          Back to sign-in
        </Link>
      </div>
    </AuthCard>
  );
}
