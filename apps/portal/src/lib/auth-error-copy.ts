/**
 * What the portal's sign-in, MFA and password-reset pages say for each API
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
  'Confirm your email address before signing in. Open the confirmation link sent to your inbox, then try again.';
const DEVICE_REFUSED =
  'This account cannot be signed in from this device. Contact the business that runs this account for help.';

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
  'AUTH_METHOD_DISABLED',
  'DEVICE_FINGERPRINT_REQUIRED',
  'PUBLISHABLE_KEY_INVALID',
  'ORIGIN_NOT_ALLOWED',
  'API_KEY_MISSING',
  'API_KEY_INVALID',
  'API_KEY_SCOPE_INSUFFICIENT',
  'IP_NOT_ALLOWED',
]);

function isServiceFailure(code: string): boolean {
  return SERVICE_CODES.has(code) || /^HTTP_5\d\d$/.test(code);
}

function isThrottle(code: string): boolean {
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

function throttleCopy(code: string, retryAfterSeconds: number | undefined): string {
  const wait = waitPhrase(retryAfterSeconds);
  return code === 'TOO_MANY_FAILED_ATTEMPTS'
    ? `Sign-in to this account is paused after too many unsuccessful attempts. ${wait}, then try again.`
    : `Too many attempts right now. ${wait}, then try again.`;
}

/** Codes both the password step and the MFA step can end in, once the credential verified. */
function afterCredentialCopy(code: string): string | undefined {
  if (code === 'EMAIL_NOT_VERIFIED') return EMAIL_NOT_VERIFIED;
  if (code === 'DEVICE_BLOCKED' || code === 'DEVICE_LIMIT_REACHED') return DEVICE_REFUSED;
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
 * @example
 * forgotPasswordErrorCopy('RATE_LIMITED', 600); // 'Too many attempts right now. Wait about 10 minutes, then try again.'
 */
export function forgotPasswordErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'missing') return 'Enter your email address to continue.';
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
