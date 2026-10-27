import * as React from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ActionForm } from '@/components/ActionForm';
import { AuthCard } from '@/components/AuthCard';
import { SubmitButton } from '@/components/SubmitButton';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/api';
import { CLOUD_HANDOFF_COOKIE, handoffEmail } from '../handoff-cookie';
import { cancelCloudHandoff, confirmCloudHandoff } from './actions';

export const metadata: Metadata = { title: 'Continue signing in · Rekey' };

/**
 * Shown when a Cloud sign-in was posted from another site. Nothing changes
 * until the operator chooses; a signed-in browser is told it would switch.
 */
export default async function CloudHandoffConfirmPage(): Promise<React.JSX.Element> {
  const jar = await cookies();
  const idToken = jar.get(CLOUD_HANDOFF_COOKIE)?.value;
  if (!idToken) redirect('/login?error=cloud_handoff');
  const email = handoffEmail(idToken);
  const signedIn = jar.has(ACCESS_COOKIE) || jar.has(REFRESH_COOKIE);
  const account = <strong className="font-medium">{email ?? 'the account that site chose'}</strong>;

  return signedIn ? (
    <AuthCard
      title="Switch account?"
      subtitle="You are already signed in. Another site asked to sign this browser in to a different Rekey account."
    >
      <p className="text-sm">
        Continuing signs you in as {account} and ends your current session in this browser. If you did not start
        this sign-in, keep your current session.
      </p>
      <ActionForm action={confirmCloudHandoff}>
        <SubmitButton
          pendingLabel="Switching…"
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {email ? `Continue as ${email}` : 'Continue'}
        </SubmitButton>
      </ActionForm>
      <ActionForm action={cancelCloudHandoff}>
        <SubmitButton
          pendingLabel="Returning…"
          className="w-full rounded-md border border-[var(--color-border)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          Keep my current session
        </SubmitButton>
      </ActionForm>
    </AuthCard>
  ) : (
    <AuthCard title="Continue signing in" subtitle="Another site asked to sign this browser in to Rekey.">
      <p className="text-sm">
        Continuing signs you in as {account}. Only continue if you started this sign-in yourself.
      </p>
      <ActionForm action={confirmCloudHandoff}>
        <SubmitButton
          pendingLabel="Switching…"
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {email ? `Continue as ${email}` : 'Continue'}
        </SubmitButton>
      </ActionForm>
      <ActionForm action={cancelCloudHandoff}>
        <SubmitButton
          pendingLabel="Cancelling…"
          className="w-full rounded-md border border-[var(--color-border)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          Cancel
        </SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
