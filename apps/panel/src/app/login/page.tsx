import * as React from 'react';
import type { Metadata } from 'next';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { publicPost, publicGet, setSessionCookies, PanelApiError, type SignInResponse, type AuthResponse } from '@/lib/api';
import { PasskeyLoginButton } from '@/components/PasskeyLoginButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { AuthCard, OrDivider } from '@/components/AuthCard';
import { OAuthButton, PROVIDER_LABELS } from '@/components/OAuthButton';
import { startOAuth } from './oauth-start';
import { Banner } from '@/components/Banner';
import { TrackView } from '@/components/analytics/track-view';
import { AnalyticsEvent } from '@/lib/analytics';
import { safeNext } from '@/lib/safe-next';
import { clearMfaChallenge, mfaVerifyPath, writeMfaChallenge } from '@/lib/mfa-challenge';
import { LOGIN_ERROR_MESSAGES, loginErrorCode } from './error-messages';


async function signIn(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = safeNext(formData.get('next'));
  // Preserve the typed email (never the password) so a failed sign-in doesn't
  // make the operator retype it, and the `next` target so a retry still
  // round-trips back (e.g. accept-invite).
  const keep = `&email=${encodeURIComponent(email)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  const jar = await cookies();
  clearMfaChallenge(jar);
  if (!email || !password) redirect(`/login?error=missing${keep}`);

  let result: SignInResponse;
  try {
    result = await publicPost<SignInResponse>('/api/v1/tenant/auth/sign-in', { email, password });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/login?error=${loginErrorCode(err.code)}${keep}`);
    }
    throw err;
  }

  if (result.mfaRequired) {
    await writeMfaChallenge(jar, result.mfaChallengeToken);
    // Carry `next` through the MFA hop so an invite round-trip survives it.
    redirect(mfaVerifyPath({ next }));
  }

  await setSessionCookies(result);
  if (next) redirect(`${next}${next.includes('?') ? '&' : '?'}e=login`);
  redirect('/applications?e=login');
}

/** Begin a passkey sign-in, returns the assertion options for the browser. */
async function startPasskeyLogin(): Promise<
  | { ok: true; options: Record<string, unknown>; expectedChallenge: string }
  | { ok: false; message: string }
> {
  'use server';
  try {
    const data = await publicPost<{ options: Record<string, unknown>; expectedChallenge: string }>(
      '/api/v1/tenant/auth/passkeys/authenticate/start',
      {},
    );
    return { ok: true, ...data };
  } catch (err) {
    if (err instanceof PanelApiError) {
      return { ok: false, message: LOGIN_ERROR_MESSAGES[err.code] ?? err.message };
    }
    throw err;
  }
}

/** Verify the assertion + mint a session. Redirects on success or failure. */
async function completePasskeyLogin(formData: FormData): Promise<void> {
  'use server';
  const expectedChallenge = String(formData.get('expectedChallenge') ?? '');
  // Carry `next` through the passkey ceremony (same rules as the password
  // form) so an invite round-trip survives a passkey sign-in too.
  const next = safeNext(formData.get('next'));
  const keep = next ? `&next=${encodeURIComponent(next)}` : '';
  let response: unknown;
  try {
    response = JSON.parse(String(formData.get('response') ?? ''));
  } catch {
    redirect(`/login?error=PASSKEY_RESPONSE_INVALID${keep}`);
  }
  let result: Pick<AuthResponse, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'>;
  try {
    result = await publicPost<typeof result>(
      '/api/v1/tenant/auth/passkeys/authenticate/complete',
      { response, expectedChallenge },
    );
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/login?error=${loginErrorCode(err.code)}${keep}`);
    }
    throw err;
  }
  clearMfaChallenge(await cookies());
  await setSessionCookies(result);
  if (next) redirect(`${next}${next.includes('?') ? '&' : '?'}e=login_passkey`);
  redirect('/applications?e=login_passkey');
}

/**
 * Make the password form secondary, behind a disclosure.
 *
 * For a deployment where nearly every operator arrives through the OIDC button,
 * a password form sitting above it is the wrong default: it is the path almost
 * nobody should take, occupying the position that says "take this path".
 * Password sign-in is not removed, an operator who set one, or who needs it
 * when the provider is down, still has it one click away.
 */
const PASSWORD_SECONDARY = process.env.PANEL_PASSWORD_LOGIN_SECONDARY === 'true';

/**
 * Which credential this deployment leads with.
 *
 * `magic_link` suits a deployment whose operators never set a password,
 * arriving by invite, by OIDC, or by emailed link, where a password form in
 * the primary position is the path almost nobody should take, sitting where the
 * page says "start here".
 *
 * Default is `password`, so no existing deployment changes behaviour and the
 * open-source default is the conventional one. Password sign-in is never
 * removed, only moved: it stays one click away, because an operator who set one
 * must not be locked out by a preference, and because email delivery failing is
 * exactly when you need another way in.
 */
const PRIMARY_SIGNIN = process.env.PANEL_PRIMARY_SIGNIN === 'magic_link' ? 'magic_link' : 'password';

export const metadata: Metadata = { title: 'Sign in · Rekey' };


export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const reason = typeof params.reason === 'string' ? params.reason : undefined;
  const keepEmail = typeof params.email === 'string' ? params.email : undefined;
  // Round-tripped through the form so accept-invite (etc.) can resume after
  // sign-in. The server action re-validates it before redirecting.
  const next = typeof params.next === 'string' ? params.next : undefined;
  // `?password=1` is how the disclosure below reveals the form. The flag only
  // decides the DEFAULT, a deployment can demote password sign-in without
  // taking it away, which matters when the identity provider is the thing
  // that is down.
  const passwordRequested = params.password === '1';

  // Which social providers are enabled on this deployment (server env). Empty
  // (or unreachable API) → no social buttons, just password + passkey.
  const oauthProviders = await publicGet<{ providers: string[] }>('/api/v1/tenant/auth/oauth/providers')
    .then((d) => d.providers)
    .catch(() => [] as string[]);

  // Demote the password form when a provider is configured (the original
  // reason) OR when this deployment leads with magic link. Never demote it with
  // nothing else on the page: hiding the only way in locks every operator out
  // of their own panel, which is a worse failure than an unwanted default.
  const magicLinkPrimary = PRIMARY_SIGNIN === 'magic_link' && !passwordRequested;
  const showPasswordSecondary =
    !passwordRequested &&
    (magicLinkPrimary || (PASSWORD_SECONDARY && oauthProviders.length > 0));

  /**
   * Where this deployment sends someone who authenticated fine but is not an
   * operator here. Unset means the banner states the fact and stops, which is
   * right for a self-host that hands out invite keys by its own means.
   *
   * Rekey Cloud sets it to the pricing page, because on Cloud the workspace is
   * created by the purchase: "subscribe and you are in" is the literal truth
   * there and a lie anywhere else, which is why it is not the default.
   */
  const inviteHelpUrl = process.env.PANEL_INVITE_HELP_URL?.trim() || null;
  // The wording is the deployment's too, not just the destination. The default
  // is neutral because this panel ships in the open-source product and has no
  // idea how a given operator grants access, hardcoding "subscribe at
  // rekey.dev" here would put our commercial funnel in everybody's self-host,
  // which is the same reason the sign-up page says only "Find out how to get
  // one". Rekey Cloud sets the text to name the plan, because there the
  // workspace genuinely is created by the purchase.
  const inviteHelpText = process.env.PANEL_INVITE_HELP_TEXT?.trim() || 'Find out how to get access';
  const inviteHelp = inviteHelpUrl ? { href: inviteHelpUrl, linkText: inviteHelpText } : null;

  const inputCls =
    'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

  return (
    <AuthCard
      title="Sign in to Rekey"
      subtitle="Operator account: manage Applications, billing, and team."
    >
      <TrackView event={AnalyticsEvent.LoginPageView} />
        {reason === 'expired' && (
          <p className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            Your session expired. Please sign in again.
          </p>
        )}
        {reason === 'session_interrupted' && (
          <p className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            Your session was interrupted while it renewed, so it was signed out to keep your account safe. Sign in again to carry on.
          </p>
        )}
        {reason === 'reset' && (
          <Banner tone="success">Password updated. Sign in with your new password.</Banner>
        )}
        {reason === 'password_changed' && (
          <Banner tone="success">
            Password changed, and every session was signed out, this one included. Sign in with the new password.
          </Banner>
        )}
        {/* Only render for codes we actually emit. An unknown ?error= (stale
            bookmark, crafted link) used to paint an unexplained failure on the
            page where trust is decided, render nothing instead. */}
        {error && LOGIN_ERROR_MESSAGES[error] && (
          <Banner tone="error">
            {LOGIN_ERROR_MESSAGES[error]}
            {/* The invite/plan cases are the only ones where the operator can
                do something about it themselves, so they are the only ones
                that get a destination. */}
            {inviteHelp && error === 'OPERATOR_INVITE_REQUIRED' ? (
              <span className="mt-1 block text-sm">
                <a
                  href={inviteHelp.href}
                  className="underline underline-offset-2"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {inviteHelp.linkText}
                </a>
              </span>
            ) : null}
          </Banner>
        )}

        {oauthProviders.length > 0 && (
          <>
            <div className="space-y-2">
              {oauthProviders
                .filter((p) => p in PROVIDER_LABELS)
                .map((p) => (
                  // OAuthButton is a SubmitButton under another name, so this
                  // pair needs ActionForm like any other: startOAuth redirects
                  // to the provider, and if that redirect does not commit the
                  // button would sit on "Redirecting…", disabled, for good.
                  <ActionForm key={p} action={startOAuth.bind(null, p, next ?? null)}>
                    <OAuthButton provider={p} label={PROVIDER_LABELS[p]!} />
                  </ActionForm>
                ))}
            </div>
            {!showPasswordSecondary && <OrDivider />}
          </>
        )}

        {/* Magic link in the primary slot. Deliberately a link to the existing
            page rather than a second copy of its form: that page owns the
            request action, the sent/error states and the dev-mode token
            fallback, and duplicating it here would mean two implementations of
            one flow drifting apart. */}
        {magicLinkPrimary && (
          <>
            {oauthProviders.length > 0 && <OrDivider />}
            <Link
              href={`/magic-link${next ? `?next=${encodeURIComponent(next)}` : ''}`}
              className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              Email me a sign-in link
            </Link>
            <p className="text-center text-xs text-[var(--color-muted-fg)]">
              No password needed. We send a one-time link to your inbox.
            </p>
          </>
        )}

        {showPasswordSecondary && (
          <p className="text-center text-sm text-[var(--color-text-muted)]">
            {/* A plain link, not client state: this page is a server component
                and the disclosure has to work with JS off, which is the whole
                reason for keeping a password path at all. */}
            <Link
              href={`/login?password=1${next ? `&next=${encodeURIComponent(next)}` : ''}`}
              className="underline"
            >
              Use a password instead
            </Link>
          </p>
        )}

        {!showPasswordSecondary && (
        <ActionForm action={signIn} className="space-y-5">
          {/* `hidden` attr keeps Tailwind's space-y sibling selector from
              shifting the first label's margin. */}
          {next && <input type="hidden" hidden name="next" value={next} />}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Email</span>
            <input type="email" name="email" required autoComplete="email"
              defaultValue={keepEmail}
              placeholder="you@example.com" className={inputCls} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Password</span>
            <input type="password" name="password" required autoComplete="current-password" className={inputCls} />
          </label>
          <SubmitButton
            pendingLabel="Signing in…"
            className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            Sign in
          </SubmitButton>
        </ActionForm>
        )}

        {/* Passwordless alternative, phishing-resistant, no second factor needed. */}
        {!showPasswordSecondary && <OrDivider />}
        <PasskeyLoginButton start={startPasskeyLogin} complete={completePasskeyLogin} next={next} />

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-[var(--color-muted-fg)] pt-2 border-t border-[var(--color-border)]">
          <Link href="/sign-up" className="hover:text-[var(--color-fg)]">
            Create workspace
          </Link>
          <Link href="/magic-link" className="hover:text-[var(--color-fg)]">
            Email a sign-in link
          </Link>
          <Link href="/forgot-password" className="hover:text-[var(--color-fg)]">
            Forgot password?
          </Link>
        </div>

        {/* Demo-deployment notice. Opt-in via PANEL_DEMO_NOTICE so a self-hosted
            or production panel never tells operators their data may be wiped,
            it said that unconditionally before. Deliberately NOT a
            NEXT_PUBLIC_* var: those are inlined at build time, so a
            self-hoster setting it in compose env would see no change without
            rebuilding the image. This page is a server component, so a plain
            server env var is read at runtime. */}
        {process.env.PANEL_DEMO_NOTICE === '1' && (
          <p className="text-center text-xs text-[var(--color-muted-fg)]">
            Demo environment: data may be reset without notice.
          </p>
        )}
    </AuthCard>
  );
}
