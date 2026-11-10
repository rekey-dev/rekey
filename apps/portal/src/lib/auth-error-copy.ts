/**
 * What the portal's sign-in, sign-in link, MFA and password-reset pages say for each API
 * error code they are redirected back with.
 *
 * Credential failures share one line on purpose: the API answers
 * INVALID_CREDENTIALS for both an unknown address and a wrong password, and the
 * page must not tell them apart either.
 */

const CREDENTIALS = 'Could not sign in. Check your email and password and try again.';
const UNAVAILABLE =
  'Sign-in is not working on this site right now. This is not a problem with your account. ' +
  'Try again later, and if it keeps happening, contact the business that runs this account.';
const UNKNOWN = 'Could not sign in. Try again, and if it keeps happening, contact the business that runs this account.';
const EMAIL_NOT_VERIFIED =
  'Confirm your email address before signing in. Open the confirmation link sent to your inbox, or send a new one.';
const DEVICE_REFUSED =
  'This account cannot be signed in from this device. Contact the business that runs this account for help.';
const SIGNS_IN_THROUGH_APP =
  'This account signs in through the app installed on your computer. Open the app to manage your account, or ' +
  'contact support for help with billing or devices.';
const DEVICE_LIMIT =
  'This account is already signed in on as many devices as its plan allows. Open the app on a computer you ' +
  'already use to manage your devices, or contact support for help.';

const METHOD_OFF =
  'This way of signing in is turned off for this account. Reload the page to see how you can sign in.';
const LINK_EXPIRED = 'This sign-in link expired. Links work for 15 minutes, so request a new one.';
const LINK_SPENT = 'This sign-in link is no longer valid. It may have been used already, so request a new one.';

const SIGN_IN_LINK_COPY: Readonly<Record<string, string>> = {
  MAGIC_LINK_EXPIRED: LINK_EXPIRED,
  MAGIC_LINK_USED: LINK_SPENT,
  MAGIC_LINK_INVALID: LINK_SPENT,
  MAGIC_LINK_WRONG_APPLICATION: LINK_SPENT,
  MAGIC_LINK_STALE: LINK_SPENT,
};

/** Shown when the sign-in link page is reached with no token waiting to be spent. */
export const SIGN_IN_LINK_MISSING_COPY =
  'This sign-in link expired or was already used. Request a new one.';

const LINK_LIFETIME = 'Check your inbox. The link works for 15 minutes.';

/**
 * Shown after any sign-in link request the API did not refuse for throttling or an outage.
 * With sign-up open every address gets a link, since using it creates the account,
 * so the page can say it was sent without revealing whether the address had one.
 *
 * @example
 * signInLinkSentCopy(config.auth.signup);
 */
export function signInLinkSentCopy(signupOpen: boolean): string {
  return signupOpen
    ? `We sent a sign-in link to that address. ${LINK_LIFETIME}`
    : `If that address can sign in here, we sent it a link. ${LINK_LIFETIME}`;
}

const ACCOUNT_SUSPENDED =
  'This account cannot sign in. Contact the business that runs this account for help.';

/** Longest wait a `?retry=` value may claim. Anything above is ignored as forged or garbled. */
const MAX_RETRY_SECONDS = 24 * 60 * 60;

const SERVICE_CODES = new Set([
  'PASSWORD_VERIFY_BUSY',
  'DEPENDENCY_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'NETWORK_ERROR',
  'REQUEST_TIMEOUT',
  'UNKNOWN_ERROR',
  'PORTAL_NOT_FOUND',
  'PUBLISHABLE_KEY_INVALID',
  'ORIGIN_NOT_ALLOWED',
  'API_KEY_MISSING',
  'API_KEY_INVALID',
  'API_KEY_SCOPE_INSUFFICIENT',
  'IP_NOT_ALLOWED',
]);

export function isServiceFailure(code: string): boolean {
  return SERVICE_CODES.has(code) || /^HTTP_5\d\d$/.test(code);
}

export function isThrottle(code: string): boolean {
  return code === 'RATE_LIMITED' || code === 'TOO_MANY_FAILED_ATTEMPTS';
}

/** "Wait about 15 minutes", rounded up so the customer never retries a moment too early. */
function waitPhrase(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return 'Wait a few minutes';
  const minutes = Math.ceil(retryAfterSeconds / 60);
  if (minutes <= 1) return 'Wait about a minute';
  if (minutes < 90) return `Wait about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `Wait about ${hours} hours`;
}

export function throttleCopy(code: string, retryAfterSeconds: number | undefined): string {
  const wait = waitPhrase(retryAfterSeconds);
  return code === 'TOO_MANY_FAILED_ATTEMPTS'
    ? `Sign-in to this account is paused after too many unsuccessful attempts. ${wait}, then try again.`
    : `Too many attempts right now. ${wait}, then try again.`;
}

/** Codes both the password step and the MFA step can end in, once the credential verified. */
function afterCredentialCopy(code: string): string | undefined {
  if (code === 'EMAIL_NOT_VERIFIED') return EMAIL_NOT_VERIFIED;
  if (code === 'DEVICE_BLOCKED') return DEVICE_REFUSED;
  if (code === 'DEVICE_LIMIT_REACHED') return DEVICE_LIMIT;
  // The application binds sign-in to a device and this deployment cannot vouch for the portal.
  if (code === 'DEVICE_FINGERPRINT_REQUIRED') return SIGNS_IN_THROUGH_APP;
  if (code === 'END_USER_BANNED') return ACCOUNT_SUSPENDED;
  return undefined;
}

const MFA_RESTART_COPY: Readonly<Record<string, string>> = {
  MFA_CHALLENGE_INVALID: 'This sign-in attempt expired. Start over and sign in again.',
  MFA_CHALLENGE_WRONG_APPLICATION: 'This sign-in attempt expired. Start over and sign in again.',
  MFA_CHALLENGE_USED: 'This sign-in attempt was already completed. Start over and sign in again.',
};

/**
 * Codes after which the MFA challenge is dead, so the customer goes back to
 * the password step instead of retrying the code.
 *
 * @example
 * isMfaRestartCode('MFA_CHALLENGE_USED'); // true
 */
export function isMfaRestartCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(MFA_RESTART_COPY, code);
}

function mfaRestartCopy(code: string): string | undefined {
  return isMfaRestartCode(code) ? MFA_RESTART_COPY[code] : undefined;
}

/** Shown on the sign-in page when the code step was reached with no live challenge. */
export const MFA_EXPIRED_COPY = 'Your sign-in attempt timed out. Sign in again to get a new code prompt.';

/**
 * @example
 * signInErrorCopy('TOO_MANY_FAILED_ATTEMPTS', 900);
 * // 'Sign-in to this account is paused after too many unsuccessful attempts. Wait about 15 minutes, then try again.'
 */
export function signInErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'INVALID_CREDENTIALS') return CREDENTIALS;
  if (code === 'AUTH_METHOD_DISABLED') return METHOD_OFF;
  const link = Object.prototype.hasOwnProperty.call(SIGN_IN_LINK_COPY, code) ? SIGN_IN_LINK_COPY[code] : undefined;
  if (link) return link;
  const restart = mfaRestartCopy(code);
  if (restart) return restart;
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  if (isServiceFailure(code)) return UNAVAILABLE;
  return afterCredentialCopy(code) ?? UNKNOWN;
}

/**
 * @example
 * mfaErrorCopy('MFA_CODE_INVALID'); // 'That code didn't verify. Try the current code from your app.'
 */
export function mfaErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'MFA_CODE_INVALID') return 'That code didn’t verify. Try the current code from your app.';
  if (code === 'MFA_CODE_REUSED') {
    return 'That code was already used. Wait for the next code from your app, then enter it.';
  }
  if (code === 'MFA_BACKUP_CODE_USED') {
    return 'That backup code was already used. Each backup code works once, so enter a different backup code.';
  }
  const restart = mfaRestartCopy(code);
  if (restart) return restart;
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  if (isServiceFailure(code)) return UNAVAILABLE;
  return afterCredentialCopy(code) ?? UNKNOWN;
}

/**
 * Whether a failed sign-in link request may say so. Only throttling and
 * failures that hit every address alike qualify; anything else could depend
 * on the address, so the page shows the same "sent" state as a success.
 *
 * @example
 * signInLinkRequestFailureShown('RATE_LIMITED'); // true
 * signInLinkRequestFailureShown('VALIDATION_ERROR'); // false
 */
export function signInLinkRequestFailureShown(code: string): boolean {
  return isThrottle(code) || isServiceFailure(code) || code === 'AUTH_METHOD_DISABLED' || code === 'AUTH_URL_NOT_ALLOWED';
}

/**
 * @example
 * signInLinkRequestErrorCopy('RATE_LIMITED', 600); // 'Too many attempts right now. Wait about 10 minutes, then try again.'
 */
export function signInLinkRequestErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'missing') return 'Enter your email address to get a sign-in link.';
  if (code === 'AUTH_METHOD_DISABLED') return METHOD_OFF;
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  return (
    'Could not send a sign-in link right now. This is not a problem with your account. Try again later, ' +
    'and if it keeps happening, contact the business that runs this account.'
  );
}

/** Shown after any confirmation link request the API did not refuse for throttling or an outage. */
export const VERIFICATION_SENT_COPY =
  'If that address needs confirming, we sent a new link. Check your inbox. The link works for 24 hours.';

/** Shown when the confirmation page is reached with no link waiting to be spent. */
export const VERIFICATION_LINK_MISSING_COPY =
  'This confirmation link expired or was already used. Send a new one below.';

export const EMAIL_CONFIRMED_COPY = 'Your email address is confirmed. You can sign in now.';

/**
 * Whether a failed confirmation link request may say so. The same rule as a
 * sign-in link request: only failures that hit every address alike.
 *
 * @example
 * verificationResendFailureShown('RATE_LIMITED'); // true
 * verificationResendFailureShown('VALIDATION_ERROR'); // false
 */
export function verificationResendFailureShown(code: string): boolean {
  return isThrottle(code) || isServiceFailure(code) || code === 'AUTH_URL_NOT_ALLOWED';
}

/**
 * @example
 * verificationResendErrorCopy('RATE_LIMITED', 600); // 'Too many attempts right now. Wait about 10 minutes, then try again.'
 */
export function verificationResendErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'missing') return 'Enter your email address to get a new confirmation link.';
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  return (
    'Could not send a confirmation link right now. This is not a problem with your account. Try again later, ' +
    'and if it keeps happening, contact the business that runs this account.'
  );
}

const VERIFY_LINK_SPENT = 'This confirmation link is not valid. Send a new one below.';

const VERIFY_EMAIL_COPY: Readonly<Record<string, string>> = {
  EMAIL_VERIFICATION_TOKEN_EXPIRED: 'This confirmation link expired. Links work for 24 hours, so send a new one below.',
  EMAIL_VERIFICATION_TOKEN_USED:
    'This confirmation link was already used. If your address is confirmed, sign in. If not, send a new link below.',
  EMAIL_VERIFICATION_TOKEN_INVALID: VERIFY_LINK_SPENT,
  EMAIL_VERIFICATION_TOKEN_WRONG_APPLICATION: VERIFY_LINK_SPENT,
  EMAIL_VERIFICATION_STALE:
    'This link was sent to an earlier email address on your account. Send a new link to your current address below.',
};

/**
 * @example
 * verifyEmailErrorCopy('EMAIL_VERIFICATION_TOKEN_EXPIRED'); // 'This confirmation link expired. ...'
 */
export function verifyEmailErrorCopy(code: string, retryAfterSeconds?: number): string {
  const known = Object.prototype.hasOwnProperty.call(VERIFY_EMAIL_COPY, code) ? VERIFY_EMAIL_COPY[code] : undefined;
  if (known) return known;
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  if (isServiceFailure(code)) return UNAVAILABLE;
  return 'Your email address could not be confirmed. Send a new link below and try again.';
}

const TWO_FACTOR_RESTART_CODES = new Set([
  'SESSION_EXPIRED',
  'USER_TOKEN_MISSING',
  'USER_TOKEN_INVALID',
  'MFA_NOT_INITIATED',
]);

/**
 * @example
 * twoFactorSetUpErrorCopy('MFA_CODE_INVALID'); // 'That code did not match. Enter the current 6-digit code from your authenticator app.'
 */
export function twoFactorSetUpErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'missing') return 'Enter the 6-digit code from your authenticator app.';
  if (code === 'MFA_CODE_INVALID') return 'That code did not match. Enter the current 6-digit code from your authenticator app.';
  if (code === 'MFA_CODE_REUSED') return 'That code was already used. Wait for the next code from your app, then enter it.';
  if (TWO_FACTOR_RESTART_CODES.has(code)) return 'This setup timed out. Reload the page to start again.';
  if (code === 'EMAIL_NOT_VERIFIED') {
    return 'Confirm your email address before you set up two-factor authentication. Use the confirmation link sent to your inbox.';
  }
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  if (isServiceFailure(code)) {
    return (
      'Two-factor setup is not working right now. This is not a problem with your account. Try again later, ' +
      'and if it keeps happening, contact the business that runs this account.'
    );
  }
  return 'Could not set up two-factor authentication. Reload the page and try again.';
}

/** Shown when password sign-in was turned off between loading a reset page and submitting it. */
export const PASSWORD_OFF_COPY =
  'Password sign-in is turned off for this account, so there is no password to reset. Sign in another way.';

/**
 * @example
 * forgotPasswordErrorCopy('RATE_LIMITED', 600); // 'Too many attempts right now. Wait about 10 minutes, then try again.'
 */
export function forgotPasswordErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'missing') return 'Enter your email address to continue.';
  if (code === 'AUTH_METHOD_DISABLED') return PASSWORD_OFF_COPY;
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  return (
    'Could not send a reset link right now. Try again later, and if it keeps happening, ' +
    'contact the business that runs this account.'
  );
}

const RESET_COPY: Readonly<Record<string, string>> = {
  PASSWORD_RESET_TOKEN_INVALID: 'This reset link is not valid. Request a new one.',
  PASSWORD_RESET_TOKEN_WRONG_APPLICATION: 'This reset link is not valid. Request a new one.',
  PASSWORD_RESET_TOKEN_USED: 'This reset link was already used. Request a new one.',
  PASSWORD_RESET_TOKEN_EXPIRED: 'This reset link expired. Request a new one.',
  PASSWORD_TOO_SHORT: 'That password is too short. Choose a longer one.',
  PASSWORD_BREACHED: 'That password appears in a known data breach. Choose a different one.',
  AUTH_METHOD_DISABLED: PASSWORD_OFF_COPY,
};

/**
 * @example
 * resetPasswordErrorCopy('PASSWORD_RESET_TOKEN_EXPIRED'); // 'This reset link expired. Request a new one.'
 */
export function resetPasswordErrorCopy(code: string, retryAfterSeconds?: number): string {
  const known = Object.prototype.hasOwnProperty.call(RESET_COPY, code) ? RESET_COPY[code] : undefined;
  if (known) return known;
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  if (isServiceFailure(code)) {
    return 'Your password could not be updated right now. Try again later, and if it keeps happening, contact the business that runs this account.';
  }
  return 'Your password could not be updated. Try again, or request a new reset link.';
}

/**
 * The `&retry=<seconds>` suffix a server action appends to its error redirect,
 * or nothing when the API gave no wait.
 *
 * @example
 * redirect(`/${slug}/login?error=${code}${retryQuery(err.retryAfterSeconds)}`);
 */
export function retryQuery(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined || !Number.isInteger(retryAfterSeconds) || retryAfterSeconds <= 0) return '';
  return `&retry=${retryAfterSeconds}`;
}

/**
 * Read `?retry=` back. It sits in the URL, so anything but a sane whole number
 * of seconds is dropped and the page falls back to "a few minutes".
 *
 * @example
 * parseRetryAfter(sp.retry); // 900, or undefined
 */
export function parseRetryAfter(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds > 0 && seconds <= MAX_RETRY_SECONDS ? seconds : undefined;
}
