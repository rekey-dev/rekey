import * as React from 'react';
import type { Metadata } from 'next';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { publicPost, publicGet, setSessionCookies, PanelApiError, type AuthResponse } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { SIGN_UP_ERROR_MESSAGES as ERROR_MESSAGES, signUpErrorCode } from './error-messages';
import { AuthCard } from '@/components/AuthCard';
import { TrackView } from '@/components/analytics/track-view';
import { AnalyticsEvent } from '@/lib/analytics';
import { safeNext } from '@/lib/safe-next';
import { termsLead } from './terms-lead';

export const metadata: Metadata = { title: 'Create your workspace · Rekey' };


type SignupMode = 'open' | 'invite' | 'closed';

/** Best-effort fetch of the deployment's registration mode (defaults open). */
async function fetchSignupMode(): Promise<SignupMode> {
  try {
    const { mode } = await publicGet<{ mode: SignupMode }>('/api/v1/tenant/auth/signup-mode');
    return mode === 'invite' || mode === 'closed' ? mode : 'open';
  } catch {
    // If the probe fails, fall back to the open form, the API still enforces
    // the real mode server-side, so a wrong guess can't bypass the gate.
    return 'open';
  }
}

async function signUp(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const workspaceName = String(formData.get('workspaceName') ?? '').trim();
  const inviteKey = String(formData.get('inviteKey') ?? '').trim();
  // Set only on the join form, whose key arrived in the invite link itself.
  const joining = formData.get('joining') === '1' && inviteKey !== '';
  const next = safeNext(formData.get('next'));
  // Preserve what the operator typed (never the password) so a failed submit
  // doesn't blank the form, a common first-signup drop-off. A key the
  // operator typed is NOT round-tripped through the URL; a join key already
  // was the URL, so it goes back where it came from.
  const keep = joining
    ? `&email=${encodeURIComponent(email)}&invite=${encodeURIComponent(inviteKey)}`
    : `&email=${encodeURIComponent(email)}&name=${encodeURIComponent(workspaceName)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  if (!email || !password || (!workspaceName && !joining)) redirect(`/sign-up?error=missing${keep}`);

  try {
    const auth = await publicPost<AuthResponse>('/api/v1/tenant/auth/sign-up', {
      email,
      password,
      ...(joining ? {} : { workspaceName }),
      ...(inviteKey ? { inviteKey } : {}),
    });
    await setSessionCookies(auth);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/sign-up?error=${signUpErrorCode(err.code)}${keep}`);
    }
    throw err;
  }
  if (next) redirect(`${next}${next.includes('?') ? '&' : '?'}e=signup`);
  redirect('/applications?e=signup');
}

const INPUT_BASE =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const [params, mode] = await Promise.all([searchParams, fetchSignupMode()]);
  // Where THIS deployment tells people to get an invite key. Optional: unset
  // means the panel says nothing, which is correct for a self-host that hands
  // keys out by its own means. Rekey Cloud points it at rekey.dev/pricing.
  const signupHelpUrl = process.env.PANEL_SIGNUP_HELP_URL?.trim() || null;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const keepEmail = typeof params.email === 'string' ? params.email : undefined;
  const keepName = typeof params.name === 'string' ? params.name : undefined;
  // Round-tripped through the form so accept-invite (etc.) can resume after
  // sign-up. The server action re-validates it before redirecting.
  const next = typeof params.next === 'string' ? params.next : undefined;
  // A workspace-bound invite from /accept-invite: this sign-up joins that
  // workspace, so there is no workspace to name and no key to paste.
  const joinKey =
    typeof params.invite === 'string' && params.invite.startsWith('rp_opinv_') ? params.invite : undefined;
  // Per-field errors render at the broken field instead of the page-top
  // banner, the operator's eye is already at the form.
  const emailError = error === 'EMAIL_ALREADY_EXISTS' ? ERROR_MESSAGES[error] : undefined;
  const passwordError = error === 'PASSWORD_TOO_SHORT' ? ERROR_MESSAGES[error] : undefined;
  const inviteError =
    error && error.startsWith('OPERATOR_INVITE') ? ERROR_MESSAGES[error] : undefined;
  // Only codes we have copy for surface at all: `?error=` is in the URL, so an
  // unrecognized value (hand-edited, or crafted into a link) previously painted
  // a real-looking "something went wrong" on a perfectly healthy form.
  const bannerError =
    error && !emailError && !passwordError && !inviteError ? ERROR_MESSAGES[error] : undefined;

  // Closed: no form at all, registration is disabled deployment-wide.
  if (mode === 'closed') {
    return (
      <AuthCard title="Registration closed" spacing="sm" className="text-center">
        <p className="text-sm text-[var(--color-muted-fg)]">
          New operator sign-up is disabled on this deployment. If you already have an account, sign in below.
        </p>
        <Link
          href="/login"
          className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          Sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      action={signUp}
      title={joinKey ? 'Create your account' : 'Create your workspace'}
      subtitle={
        joinKey
          ? 'Use the email address the invite was sent to. You join the workspace you were invited to.'
          : mode === 'invite'
            ? 'This deployment issues workspace keys. Paste the key you were given.'
            : "You'll be the owner. Invite teammates after sign-up."
      }
    >
      <TrackView event={AnalyticsEvent.RegisterPageView} />
        {next && !joinKey && <input type="hidden" hidden name="next" value={next} />}
        {joinKey && (
          <>
            <input type="hidden" hidden name="inviteKey" value={joinKey} />
            <input type="hidden" hidden name="joining" value="1" />
          </>
        )}

        {bannerError && (
          <p role="alert" className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {bannerError}
          </p>
        )}

        {mode === 'invite' && !joinKey && signupHelpUrl && (
          // A deployment-supplied pointer to wherever IT hands out keys.
          // Unset renders nothing, which is the right default for a self-host:
          // the panel has no idea how a given operator distributes keys, and
          // hardcoding rekey.dev here would put our commercial funnel in the
          // open-source product.
          <p className="text-sm text-[var(--color-text-secondary)]">
            Don&apos;t have a key?{' '}
            <a
              href={signupHelpUrl}
              className="underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Find out how to get one
            </a>
            .
          </p>
        )}

        {mode === 'invite' && !joinKey && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Invite key</span>
            <input type="text" name="inviteKey" required autoFocus
              placeholder="rp_opinv_…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={inviteError ? true : undefined}
              className={
                inviteError
                  ? INPUT_BASE.replace('border-[var(--color-border)]', 'border-red-500') + ' font-mono'
                  : INPUT_BASE + ' font-mono'
              } />
            {inviteError && (
              <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{inviteError}</span>
            )}
          </label>
        )}

        {inviteError && joinKey && (
          <p role="alert" className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {inviteError}
          </p>
        )}

        {!joinKey && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Workspace name</span>
            <input type="text" name="workspaceName" required autoFocus={mode !== 'invite'}
              defaultValue={keepName}
              placeholder="Acme Co"
              className={INPUT_BASE} />
          </label>
        )}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Email</span>
          <input type="email" name="email" required autoComplete="email"
            defaultValue={keepEmail}
            placeholder="you@example.com"
            aria-invalid={emailError ? true : undefined}
            className={
              'w-full rounded-md border bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
              (emailError
                ? 'border-red-500 focus:ring-red-500/30 focus:border-red-500'
                : 'border-[var(--color-border)] focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]')
            } />
          {emailError && (
            <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{emailError}</span>
          )}
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Password</span>
          <input type="password" name="password" required autoComplete="new-password" minLength={8}
            placeholder="at least 8 characters"
            aria-invalid={passwordError ? true : undefined}
            className={
              'w-full rounded-md border bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
              (passwordError
                ? 'border-red-500 focus:ring-red-500/30 focus:border-red-500'
                : 'border-[var(--color-border)] focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]')
            } />
          {passwordError && (
            <span role="alert" className="block text-xs text-red-600 dark:text-red-400">{passwordError}</span>
          )}
        </label>
        <SubmitButton
          pendingLabel={joinKey ? 'Creating account…' : 'Creating workspace…'}
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        >
          {joinKey ? 'Create account and join' : 'Create workspace'}
        </SubmitButton>

        {/* No env var for the marketing host, the panel links rekey.dev
            absolutely elsewhere (docs, MCP guide), so match that. */}
        <p className="text-xs text-[var(--color-muted-fg)] text-center">
          {termsLead(Boolean(joinKey))}{' '}
          <a
            href="https://rekey.dev/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[var(--color-fg)]"
          >
            Terms of Service
          </a>{' '}
          and{' '}
          <a
            href="https://rekey.dev/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[var(--color-fg)]"
          >
            Privacy Policy
          </a>
          .
        </p>

        <p className="text-sm text-[var(--color-muted-fg)] text-center pt-2 border-t border-[var(--color-border)]">
          Already have an account?{' '}
          <Link href="/login" className="underline hover:text-[var(--color-fg)]">
            Sign in
          </Link>
        </p>
    </AuthCard>
  );
}
