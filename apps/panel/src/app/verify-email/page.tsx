import * as React from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from '@/components/Link';
import { ACCESS_COOKIE, api, PanelApiError } from '@/lib/api';
import { AuthCard } from '@/components/AuthCard';
import { Banner } from '@/components/Banner';
import { SubmitButton } from '@/components/SubmitButton';
import { API_URL_MISSING_MESSAGES, normalizeErrorCode } from '@/lib/error-code';

export const metadata: Metadata = { title: 'Confirm your email · Rekey' };

/**
 * Where the link in an operator's confirmation email lands
 * (/verify-email?token=…).
 *
 * Confirming keeps the password that was chosen at sign-up. The link goes to
 * the mailbox, and the person reading it may not be who created the account,
 * so the link alone confirms nothing:
 *
 *   - It needs a session of the account it was mailed for. Whoever can sign
 *     in already holds the password, so keeping it takes nothing from them.
 *     Someone who cannot sign in is pointed at the emailed sign-in link,
 *     which confirms the address and removes the password instead.
 *   - Nothing happens on load. Mail scanners follow links; the signed-in
 *     operator presses the button and the server action spends the token.
 */
async function confirm(formData: FormData): Promise<void> {
  'use server';
  const token = String(formData.get('token') ?? '');
  if (!token) redirect('/verify-email?error=missing');
  try {
    await api<{ ok: true }>({ method: 'POST', path: '/api/v1/tenant/auth/verify-email', body: { token } });
  } catch (err) {
    if (err instanceof PanelApiError) {
      const code = normalizeErrorCode(err.code, ERR);
      // The session ended between the page and the button: sign in and come back.
      if (code === 'TENANT_SESSION_MISSING' || code === 'TENANT_SESSION_INVALID') redirect(signInPath(token));
      redirect(`/verify-email?token=${encodeURIComponent(token)}&error=${encodeURIComponent(code)}`);
    }
    throw err;
  }
  redirect('/verify-email?done=1');
}

/** The sign-in page, set to come back here with the token afterwards. */
function signInPath(token: string): string {
  return `/login?next=${encodeURIComponent(`/verify-email?token=${encodeURIComponent(token)}`)}`;
}

const ERR: Record<string, string> = {
  ...API_URL_MISSING_MESSAGES,
  missing: 'This page needs the link from your confirmation email.',
  TENANT_SESSION_MISSING: '',
  TENANT_SESSION_INVALID: '',
  EMAIL_VERIFICATION_WRONG_ACCOUNT:
    'This confirmation link belongs to a different account than the one you are signed in to. Sign out, sign in to the account the email was sent to, and open the link again.',
  EMAIL_VERIFICATION_TOKEN_INVALID:
    'This confirmation link is invalid, or a newer confirmation email replaced it. Use the newest email, or send a new one from the notice at the top of the panel.',
  EMAIL_VERIFICATION_TOKEN_USED:
    'This confirmation link was already used. If the notice at the top of the panel is gone, your address is confirmed.',
  EMAIL_VERIFICATION_TOKEN_EXPIRED: 'This confirmation link expired. Send a new one from the notice at the top of the panel.',
  EMAIL_VERIFICATION_STALE: 'This confirmation link was sent to an address the account no longer uses. Send a new one from the notice at the top of the panel.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  unknown: 'Could not confirm your address. Send a new confirmation email from the notice at the top of the panel.',
};

const PRIMARY =
  'block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
const SECONDARY =
  'block w-full rounded-md border border-[var(--color-border)] px-4 py-2.5 text-center text-sm font-medium hover:bg-[var(--color-surface-hover,transparent)] transition-colors';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const error = typeof params.error === 'string' ? ERR[params.error] || undefined : undefined;
  const signedIn = Boolean((await cookies()).get(ACCESS_COOKIE)?.value);

  if (params.done === '1') {
    return (
      <AuthCard title="Email confirmed" spacing="sm">
        <Banner tone="success">Your address is confirmed. Your password and everything in your account are as they were.</Banner>
        <Link href="/applications" className={PRIMARY}>
          Continue to Rekey
        </Link>
      </AuthCard>
    );
  }
  if (!token) {
    return (
      <AuthCard title="Confirm your email" spacing="sm">
        {error && <Banner tone="error">{error}</Banner>}
        <p className="text-sm text-[var(--color-muted-fg)]">
          To confirm your address, open the link in your confirmation email. To get a new one, sign in and choose
          &quot;Send confirmation email&quot; in the notice at the top of the page.
        </p>
        <Link href={signedIn ? '/applications' : '/login'} className={PRIMARY}>
          {signedIn ? 'Continue to Rekey' : 'Sign in'}
        </Link>
      </AuthCard>
    );
  }
  if (!signedIn) {
    return (
      <AuthCard title="Sign in to confirm your email" spacing="sm">
        <p className="text-sm text-[var(--color-muted-fg)]">
          An operator account was created with this email address. Confirming it keeps the password that was chosen
          when the account was created, so you confirm it while signed in to that account.
        </p>
        <Link href={signInPath(token)} className={PRIMARY}>
          I created this account: sign in and confirm
        </Link>
        <Banner tone="warning">
          <strong>If you did not create this account, do not confirm it.</strong> Someone else chose its password. To
          take the account over, get a sign-in link by email instead: that confirms your address and removes the
          password they set.
        </Banner>
        <Link href="/magic-link" className={SECONDARY}>
          I did not create it: email me a sign-in link
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard action={confirm} title="Confirm your email" spacing="sm">
      {error && <Banner tone="error">{error}</Banner>}
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-[var(--color-muted-fg)]">
        Confirm that the email address of the account you are signed in to is yours, to finish setting up your Rekey
        operator account.
      </p>
      <Banner tone="warning">
        <strong>Only confirm if you created this account yourself.</strong> Confirming keeps the password you signed
        in with.
      </Banner>
      <SubmitButton pendingLabel="Confirming…" className={PRIMARY}>
        Confirm email
      </SubmitButton>
    </AuthCard>
  );
}
