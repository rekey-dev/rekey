/**
 * What a support action reports back, and where.
 *
 * These maps and the banner that renders them used to live inside the Overview
 * page, which meant three of the six actions were silent: `unlockAccount`,
 * `revokeAllSessions` and `revokeSession` all redirect to the **Security** tab,
 * and nothing there read `support` or `supportError`. An operator clicking
 * "Clear lockout" on an account that was never locked saw the page re-render
 * unchanged, so they either concluded the button was broken or told the
 * customer to try again, which is exactly the outcome the "not locked" wording
 * exists to prevent. The error path was worse: a 410, a 403 and a 429 all
 * produced no banner at all, making a refused action indistinguishable from a
 * successful one.
 *
 * So the vocabulary lives here, in one module both tabs import.
 */

import * as React from 'react';
import { errorMessage } from '@/lib/error-message';
import { Banner } from '@/components/Banner';

/** What each completed support action reports back. */
export const SUPPORT_DONE: Record<string, { tone: 'success' | 'info'; text: string }> = {
  unlocked: { tone: 'success', text: 'Sign-in lockout cleared. They can try again now.' },
  'not-locked': {
    tone: 'info',
    // Not "unlocked". The operator asked whether the lockout was the problem,
    // and the honest answer is that it was not, so they keep looking.
    text: 'Nothing to clear: this account was not locked and had no recent failures. Whatever is stopping them signing in, it is not the lockout.',
  },
  'verification-sent': { tone: 'success', text: 'Verification email sent.' },
  'verification-not-sent': {
    tone: 'info',
    text: 'A fresh verification token was minted, but the email could not be sent, because this Application has no working transport. Check Email → Delivery.',
  },
  'reset-sent': { tone: 'success', text: 'Password-reset email sent, and the reason recorded.' },
  'reset-not-sent': {
    tone: 'info',
    text: 'A reset token was minted, but the email could not be sent, because this Application has no working transport. Check Email → Delivery.',
  },
  'session-revoked': { tone: 'success', text: 'Session revoked.' },
};

export const SUPPORT_ERR: Record<string, string> = {
  REASON_REQUIRED: 'Say why you are sending a reset. It goes in the audit trail.',
  EMAIL_ALREADY_VERIFIED: 'That address is already verified; there is nothing to send.',
  END_USER_HAS_NO_PASSWORD:
    'This account has no password. They sign in with OAuth, a passkey or a magic link. A reset would strand them on a form they cannot complete.',
  // Reachable whenever the `password` method is turned off on an Application
  // whose end-users still carry a hash: `ensurePasswordMethodEnabled` refuses
  // before the send. Without this line the operator got the raw code.
  AUTH_METHOD_DISABLED:
    'Password sign-in is turned off for this Application, so a reset link would lead nowhere. Turn it back on under Authentication, or help them in with a magic link.',
  END_USER_ERASED: 'This end-user was erased. Support actions no longer apply.',
  RATE_LIMITED: 'Too many sends in a short window. Wait a moment and try again.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot perform support actions on this Application.',
};

/**
 * The banner for whatever the last support action did. Renders nothing when
 * there is nothing to report, so both tabs can mount it unconditionally.
 */
export function SupportFeedback({
  done,
  error,
}: {
  done?: string | undefined;
  error?: string | undefined;
}): React.JSX.Element | null {
  const result = done ? SUPPORT_DONE[done] : undefined;
  const signedOut = done?.startsWith('signed-out:') ? Number(done.split(':')[1]) : null;
  const impEnded = done?.startsWith('impersonations-ended:') ? Number(done.split(':')[1]) : null;

  if (!result && signedOut === null && impEnded === null && error === undefined) return null;

  return (
    <>
      {result && <Banner tone={result.tone}>{result.text}</Banner>}
      {signedOut !== null && !Number.isNaN(signedOut) && (
        <Banner tone="success">
          {signedOut === 0
            ? 'No sessions were open, so nothing to sign out.'
            : `Signed out of ${signedOut} session${
                signedOut === 1 ? '' : 's'
              }. Access tokens already issued stay valid until they expire.`}
        </Banner>
      )}
      {impEnded !== null && !Number.isNaN(impEnded) && (
        <Banner tone={impEnded === 0 ? 'info' : 'success'}>
          {impEnded === 0
            ? 'No impersonation was live, so nothing to end.'
            : `Ended ${impEnded} live impersonation${impEnded === 1 ? '' : 's'}. The tokens they issued are invalid now.`}
        </Banner>
      )}
      {error !== undefined && <Banner tone="error">{errorMessage(SUPPORT_ERR, error)}</Banner>}
    </>
  );
}
