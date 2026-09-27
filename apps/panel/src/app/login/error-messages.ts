import { API_URL_MISSING_MESSAGES, normalizeErrorCode, UNKNOWN_ERROR_CODE } from '@/lib/error-code';

/**
 * Banner copy for `/login?error=<code>`. Only codes in this map render, so
 * every redirect to `/login` passes its code through `loginErrorCode` first.
 */
export const LOGIN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ...API_URL_MISSING_MESSAGES,
  missing: 'Email and password are required.',
  // Generic codes the sign-in path can emit. Required entries now that an
  // unrecognised ?error= renders nothing at all.
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  NO_TENANT_MEMBERSHIPS: 'Your account has no workspace memberships. Ask an owner for an invite.',
  PASSKEY_UNKNOWN: 'No operator account matches that passkey. Register it first under Account → Passkeys.',
  PASSKEY_AUTHENTICATION_FAILED: 'Passkey sign-in did not verify. Try again.',
  PASSKEY_RESPONSE_INVALID: 'The browser returned an invalid passkey response. Retry.',
  WEBAUTHN_NOT_CONFIGURED: 'Passkey sign-in is not enabled on this deployment.',
  // The one an operator hits after a *successful* authentication: the account
  // is real, the password was right, and this deployment simply has not let
  // them in. Reported externally as rekey-dev/rekey#19, where it rendered
  // nothing at all, the code was not in this map, and an unmapped code paints
  // no banner. Silence on the screen where trust is decided.
  //
  // The wording differs by deployment and must: a self-hoster's operators get
  // an invite key from whoever runs the box, while Rekey Cloud creates the
  // workspace when a plan is bought. `PANEL_INVITE_HELP_URL` decides which
  // sentence and whether there is a link, exactly as PANEL_SIGNUP_HELP_URL
  // already does on the sign-up page.
  OPERATOR_INVITE_REQUIRED: 'This deployment is invite-only, and this account has not been invited yet.',
  OPERATOR_SIGNUP_CLOSED: 'This deployment is not accepting new operators.',
  OAUTH_PROVIDER_NOT_CONFIGURED: 'That sign-in provider is not enabled on this deployment.',
  OAUTH_PROVIDER_UNKNOWN: 'Unknown sign-in provider.',
  OAUTH_EMAIL_NOT_VERIFIED: 'Your provider account email is not verified. Verify it at the provider, then retry.',
  OAUTH_NO_EMAIL: 'Your provider account did not share an email. Grant email access, then retry.',
  oauth_state: 'Sign-in session expired or could not be verified. Please try again.',
  oauth_no_code: 'The provider sent you back without an authorization code. Start the sign-in again.',
  oauth_no_state: 'That sign-in link is missing its state value. Start the sign-in again.',
  // Named precisely because it is the one with a cause worth chasing: the
  // browser did not return the cookie we set when the flow began.
  oauth_cookie_missing:
    'Your browser did not send back the sign-in cookie. If you are blocking cookies for this site, allow them and try again. Otherwise this is a bug worth reporting.',
  oauth_state_mismatch:
    'This sign-in link belongs to a different attempt. Start again from this page rather than reusing an old link.',
  oauth_provider_mismatch: 'That sign-in link is for a different provider. Start again.',
  oauth_denied: 'Sign-in was cancelled at the provider.',
  cloud_handoff: 'That sign-in link is missing its token. Start again from rekey.dev.',
  OIDC_ASSERTION_INVALID: 'That sign-in link is not valid. They are single-use and short-lived. Start again from rekey.dev.',
  OIDC_ASSERTION_NOT_CONFIGURED: 'This deployment does not accept that kind of sign-in.',
  magic_link_missing: 'That sign-in link is missing its token. Request a fresh one.',
  MAGIC_LINK_TOKEN_INVALID: 'That sign-in link is invalid. Request a fresh one.',
  MAGIC_LINK_TOKEN_USED: 'That sign-in link was already used. Request a fresh one.',
  MAGIC_LINK_TOKEN_EXPIRED: 'That sign-in link expired. Request a fresh one.',
  // The API answers 503 with this code when Postgres or Redis is down or
  // saturated. The operator cannot fix it from here, but a retry often works.
  DEPENDENCY_UNAVAILABLE:
    'Sign-in is temporarily unavailable because a service this deployment depends on is not responding. Wait a minute and try again.',
  // Every code without its own copy lands here via normalizeErrorCode, so a
  // failed sign-in is never silent.
  [UNKNOWN_ERROR_CODE]:
    'Sign-in did not complete. Try again, and if it keeps failing, contact whoever runs this deployment.',
};

/**
 * Narrow an API error code to one the login page has copy for.
 *
 * @example
 * redirect(`/login?error=${loginErrorCode(err.code)}`);
 */
export function loginErrorCode(code: string): string {
  return encodeURIComponent(normalizeErrorCode(code, LOGIN_ERROR_MESSAGES));
}
