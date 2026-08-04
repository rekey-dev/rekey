/**
 * Invitation acceptance flow.
 *
 *   1. GET /preview unauth — show workspace name + role + expiry.
 *   2. If signed in: POST /accept directly + persist new session, hop to /applications.
 *   3. If not signed in: route to /login?inviteToken=… so the user can
 *      sign in then come back. (We could also offer sign-up here; deferred.)
 */

import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { publicGet, setSessionCookies, ACCESS_COOKIE, PanelApiError, api } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard } from '@/components/AuthCard';
import { formatDateTime } from '@/lib/date';
import { Banner } from '@/components/Banner';

export const metadata: Metadata = { title: 'Accept invitation · Rekey' };

interface PreviewDto {
  tenantId: string;
  tenantName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedEmail: string;
  expiresAt: string;
}

interface AcceptResponse {
  membership: { id: string };
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

// AUDIT-3 (2026-05-19): the previous `accept` action used `publicPost`
// (unauthenticated) and was reachable as an orphaned server-action ID even
// though the form only wired `acceptAuthed`. Removed entirely — there is
// exactly one path now, and it uses the authed `api()` client that reads
// the session cookie.
async function acceptAuthed(formData: FormData): Promise<void> {
  'use server';
  const token = String(formData.get('token') ?? '');
  if (!token) redirect('/accept-invite?error=missing');
  try {
    const result = await api<AcceptResponse>({
      method: 'POST',
      path: '/api/v1/tenant/invitations/accept',
      body: { token },
    });
    await setSessionCookies({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/accept-invite?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/applications');
}

const ERR: Record<string, string> = {
  missing: 'Invite token missing.',
  INVITATION_NOT_FOUND:
    'This invite link is incomplete or has expired — ask whoever invited you to send a new one.',
  INVITATION_REVOKED: 'This invite was withdrawn. Ask whoever invited you to send a new one.',
  INVITATION_EXPIRED: 'This invite has expired. Ask whoever invited you to send a new one.',
  INVITATION_ALREADY_ACCEPTED: 'This invite has already been used.',
  INVITATION_NOT_USABLE: 'This invite is no longer usable. Ask for a new one.',
  PREVIEW_FAILED: 'We couldn’t check this invite just now. Please try again in a moment.',
  // Unknown codes now render nothing, so the generic ones the accept action
  // can actually redirect with have to be mapped or the failure is silent.
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
};

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  // Only codes we have copy for render a banner — an unrecognized `?error=`
  // value shows nothing rather than an unexplained "something went wrong".
  const error = typeof params.error === 'string' ? ERR[params.error] : undefined;

  if (!token) {
    return (
      <AuthCard title="Invite link incomplete" spacing="sm">
        <p className="text-sm text-[var(--color-muted-fg)]">
          This invite link is incomplete or has expired — ask whoever invited you to send a new
          one. If you already have an account, you can sign in instead.
        </p>
        <Link
          href="/login"
          className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  let preview: PreviewDto | null = null;
  let previewError: string | null = null;
  try {
    preview = await publicGet<PreviewDto>(`/api/v1/tenant/invitations/preview?token=${encodeURIComponent(token)}`);
  } catch (err) {
    previewError = err instanceof PanelApiError ? err.code : 'PREVIEW_FAILED';
  }

  const jar = await cookies();
  const signedIn = Boolean(jar.get(ACCESS_COOKIE)?.value);

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Workspace invitation</h1>

        {previewError && (
          <>
            <Banner tone="error">
              {ERR[previewError] ?? 'This invite link isn’t usable. Ask whoever invited you to send a new one.'}
            </Banner>
            {/* The dead-end state used to render no way out at all — always
                offer sign-in, since the person may already have an account. */}
            <Link
              href="/login"
              className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              Go to sign in
            </Link>
          </>
        )}

        {preview && (
          <>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 space-y-1">
              <p className="text-xs uppercase tracking-wide text-neutral-600 dark:text-neutral-500">You&apos;re invited to</p>
              <p className="text-lg font-medium">{preview.tenantName}</p>
              <p className="text-sm text-[var(--color-muted-fg)]">
                as <span className="font-medium">{preview.role}</span>
              </p>
              <p className="text-xs text-neutral-600 dark:text-neutral-500 pt-1">
                Sent to {preview.invitedEmail} · expires {formatDateTime(preview.expiresAt)}
              </p>
            </div>

            {error && <Banner tone="error">{error}</Banner>}

            {signedIn ? (
              <form action={acceptAuthed}>
                <input type="hidden" name="token" value={token} />
                <SubmitButton
                  pendingLabel="Accepting…"
                  className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Accept invitation
                </SubmitButton>
              </form>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-[var(--color-muted-fg)]">
                  Sign in to accept this invitation:
                </p>
                <Link
                  href={`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`}
                  className="block w-full rounded-md bg-neutral-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  Sign in
                </Link>
                <Link
                  href={`/sign-up?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`}
                  className="block w-full rounded-md border border-[var(--color-border)] px-4 py-2.5 text-center text-sm font-medium hover:bg-[var(--color-surface-muted)]"
                >
                  Create a new account
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
