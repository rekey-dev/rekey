/**
 * Where an invitation link lands.
 *
 *   1. GET /preview, unauthenticated: show the workspace, the role in plain
 *      words, and who it was sent to.
 *   2. Signed in: one button joins, and the new session hops into the workspace.
 *   3. Signed out: the page offers the ways in this deployment has. Every one
 *      of them carries the invitation, so a person with no account yet is
 *      created straight into the workspace, even where registration is
 *      invite-only:
 *        - a provider button (`/login/oauth`) passes it as the invite key;
 *        - "Create account and join" hands it to /sign-up;
 *        - "Sign in" brings an existing operator back here to accept.
 *      A deployment that signs operators in with its own accounts (the `rekey`
 *      provider, "Continue with Rekey.dev" on Rekey Cloud) leads with that
 *      button and offers no panel-only account, so nobody ends up with two.
 *
 * The token may also be a workspace-bound operator invite (`rp_opinv_…`, from
 * `rekey init --owner-email`). The API previews, accepts and redeems it at
 * sign-up exactly like an invitation.
 */

import * as React from 'react';
import type { Metadata } from 'next';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { publicGet, setSessionCookies, ACCESS_COOKIE, PanelApiError, api } from '@/lib/api';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard, OrDivider } from '@/components/AuthCard';
import { OAuthButton, PROVIDER_LABELS } from '@/components/OAuthButton';
import { formatDate } from '@/lib/date';
import { Banner } from '@/components/Banner';
import { ROLE_SUMMARY, roleLabel, type WorkspaceRole } from '@/lib/workspace-roles';
import { startOAuth } from '../login/oauth-start';

export const metadata: Metadata = { title: 'Join your team · Rekey' };

interface PreviewDto {
  tenantId: string;
  tenantName: string;
  role: WorkspaceRole;
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
    await setSessionCookies(result);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/accept-invite?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/applications');
}

const ERR: Record<string, string> = {
  missing: 'This invite link is incomplete. Open it again from the email, or ask for a new one.',
  INVITATION_NOT_FOUND:
    'This invite link is incomplete or has expired. Ask whoever invited you to send a new one.',
  INVITATION_REVOKED: 'This invite was withdrawn. Ask whoever invited you to send a new one.',
  INVITATION_EXPIRED: 'This invite has expired. Ask whoever invited you to send it again.',
  INVITATION_ALREADY_ACCEPTED: 'This invite has already been used. Sign in to get to your workspace.',
  INVITATION_NOT_USABLE: 'This invite is no longer usable. Ask for a new one.',
  INVITATION_EMAIL_MISMATCH:
    'You are signed in with a different email address from the one invited. Sign out, then open this link again and use the invited address.',
  PREVIEW_FAILED: 'We couldn’t check this invite just now. Please try again in a moment.',
  // Unmapped codes render nothing, so every code the accept action can
  // redirect with must have an entry here or the failure is silent.
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
};

const PRIMARY_LINK =
  'block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors';

async function signupOpenForInvitees(): Promise<boolean> {
  try {
    const { mode } = await publicGet<{ mode: string }>('/api/v1/tenant/auth/signup-mode');
    return mode !== 'closed';
  } catch {
    // The API still enforces the real mode; a wrong guess only shows a button.
    return true;
  }
}

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  // Only codes with copy render a banner; an unrecognized `?error=` value
  // shows nothing rather than an unexplained "something went wrong".
  const error = typeof params.error === 'string' ? ERR[params.error] : undefined;

  if (!token) {
    return (
      <AuthCard title="Invite link incomplete" spacing="sm">
        <p className="text-sm text-[var(--color-muted-fg)]">
          This invite link is incomplete or has expired. Ask whoever invited you to send a new
          one. If you already have an account, you can sign in instead.
        </p>
        <Link href="/login" className={PRIMARY_LINK}>
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

  // A first sign-in through a provider creates the account and uses the
  // invitation on the way, then lands back here. That is success, not an error.
  // A used operator key previews as NOT_USABLE rather than ALREADY_ACCEPTED.
  if (signedIn && (previewError === 'INVITATION_ALREADY_ACCEPTED' || previewError === 'INVITATION_NOT_USABLE')) {
    return (
      <AuthCard title="You’re in" spacing="sm">
        <p className="text-sm text-[var(--color-muted-fg)]">
          This invitation has been accepted. Your new workspace is ready.
        </p>
        <Link href="/applications" className={PRIMARY_LINK}>
          Open the workspace
        </Link>
      </AuthCard>
    );
  }

  if (!preview) {
    return (
      <AuthCard title="Join your team" spacing="sm">
        <Banner tone="error">
          {ERR[previewError ?? ''] ?? 'This invite link isn’t usable. Ask whoever invited you to send a new one.'}
        </Banner>
        <Link href="/login" className={PRIMARY_LINK}>
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  const next = `/accept-invite?token=${token}`;
  const [providers, canCreate] = signedIn
    ? [[] as string[], false]
    : await Promise.all([
        publicGet<{ providers: string[] }>('/api/v1/tenant/auth/oauth/providers')
          .then((d) => d.providers.filter((p) => p in PROVIDER_LABELS))
          .catch(() => [] as string[]),
        signupOpenForInvitees(),
      ]);
  // Operators on this deployment have an account somewhere else (Rekey Cloud's
  // rekey.dev account); a panel-only password account would be a second one.
  const ownAccounts = providers.includes('rekey');
  const orderedProviders = ownAccounts ? ['rekey', ...providers.filter((p) => p !== 'rekey')] : providers;
  const signUpHref = `/sign-up?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(preview.invitedEmail)}`;
  const signInHref = `/login?next=${encodeURIComponent(next)}&email=${encodeURIComponent(preview.invitedEmail)}`;

  return (
    <AuthCard title={`Join ${preview.tenantName}`} subtitle="You’ve been invited to work together on Rekey.">
      <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
        <p className="text-sm">
          You’ll join as <span className="font-semibold">{roleLabel(preview.role)}</span>.
        </p>
        <p className="text-sm text-[var(--color-muted-fg)]">{ROLE_SUMMARY[preview.role]}</p>
        <p className="pt-1 text-xs text-[var(--color-muted-fg)]">
          For {preview.invitedEmail} · valid until {formatDate(preview.expiresAt)}
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {signedIn ? (
        <ActionForm action={acceptAuthed} className="space-y-2">
          <input type="hidden" name="token" value={token} />
          <SubmitButton
            pendingLabel="Joining…"
            className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Join {preview.tenantName}
          </SubmitButton>
          <p className="text-center text-xs text-[var(--color-muted-fg)]">
            Use the account for {preview.invitedEmail}.
          </p>
        </ActionForm>
      ) : (
        <div className="space-y-3">
          {orderedProviders.length > 0 && (
            <div className="space-y-2">
              {orderedProviders.map((p) => (
                <ActionForm key={p} action={startOAuth.bind(null, p, next)}>
                  <OAuthButton provider={p} label={PROVIDER_LABELS[p]!} />
                </ActionForm>
              ))}
              {ownAccounts && canCreate && (
                <p className="text-center text-xs text-[var(--color-muted-fg)]">
                  No account yet? You can create one on the next screen. Use {preview.invitedEmail}.
                </p>
              )}
            </div>
          )}

          {!ownAccounts && canCreate && (
            <>
              {orderedProviders.length > 0 && <OrDivider />}
              <Link href={signUpHref} className={PRIMARY_LINK}>
                Create account and join
              </Link>
            </>
          )}

          <p className="pt-1 text-center text-sm text-[var(--color-muted-fg)]">
            Already have an account?{' '}
            <Link href={signInHref} className="font-medium text-[var(--color-fg)] underline">
              Sign in
            </Link>
          </p>
        </div>
      )}
    </AuthCard>
  );
}
