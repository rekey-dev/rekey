import * as React from 'react';

/**
 * A status/error banner. Server-rendered from the page's `?status=` /
 * `?error=` query so flows (checkout return, sign-in errors, invite results)
 * surface a clear message. RelipayError codes are mapped to friendly copy
 * where known, else shown verbatim.
 */

const MESSAGES: Record<string, string> = {
  // auth
  missing: 'Please fill in all required fields.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  EMAIL_ALREADY_EXISTS: 'An account with that email already exists — try signing in.',
  PASSWORD_TOO_SHORT: 'That password is too short for this application.',
  PASSWORD_BREACHED: 'That password has appeared in a known breach — choose a stronger one.',
  AUTH_METHOD_DISABLED: 'Password sign-in is not enabled on this application.',
  MFA_REQUIRED: 'This account has MFA enabled — this boilerplate does not implement the second-factor step.',
  PASSWORD_RESET_TOKEN_INVALID: 'That reset link is invalid.',
  PASSWORD_RESET_TOKEN_EXPIRED: 'That reset link has expired — request a new one.',
  PASSWORD_RESET_TOKEN_USED: 'That reset link was already used.',
  // billing
  BILLING_ORGANIZATION_REQUIRED:
    'This app bills per team — create or switch to a team before checking out.',
  NO_CHECKOUT_URL: 'No checkout URL was returned by the billing provider.',
  'missing-plan': 'No plan was selected.',
  // org
  'missing-name': 'Team name is required.',
  'missing-invite': 'Invite email is required.',
  ORGANIZATION_OWNER_CANNOT_LEAVE: 'The team owner cannot leave — transfer ownership first.',
};

export function Banner({
  status,
  error,
}: {
  status?: string;
  error?: string;
}): React.JSX.Element | null {
  if (error) {
    return (
      <div
        role="alert"
        className="mb-4 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300"
      >
        {MESSAGES[error] ?? error}
      </div>
    );
  }
  if (status) {
    return (
      <div className="mb-4 rounded-lg border border-relipay-600 bg-relipay-50 dark:bg-relipay-800/30 px-3 py-2 text-sm text-relipay-800 dark:text-relipay-100">
        {MESSAGES[status] ?? status}
      </div>
    );
  }
  return null;
}
