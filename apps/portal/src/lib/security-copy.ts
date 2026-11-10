/**
 * Words on the security page: what each result and refusal means for the
 * customer, and how a session or provider is named.
 *
 * Pure and runtime-neutral: the page, the actions and tests import it.
 */

export const SECURITY_DONE = {
  passwordCodeSent: 'password_code_sent',
  twoFactorOn: 'two_factor_on',
  twoFactorOff: 'two_factor_off',
  sessionRevoked: 'session_revoked',
  providerRemoved: 'provider_removed',
} as const;

const DONE_COPY: Readonly<Record<string, string>> = {
  [SECURITY_DONE.passwordCodeSent]: 'We emailed you a code. Enter it below with your new password. It works for 10 minutes.',
  [SECURITY_DONE.twoFactorOn]: 'Two-factor authentication is on.',
  [SECURITY_DONE.twoFactorOff]:
    'Two-factor authentication is off. Signing in now needs only your password or an emailed link.',
  [SECURITY_DONE.sessionRevoked]: 'That session was signed out.',
  [SECURITY_DONE.providerRemoved]: 'The sign-in provider was removed from your account.',
};

/** Null for a value the portal never sends, so a crafted `?done=` claims nothing. */
/** Errors from creating a first password, which reopen that form. */
export const FIRST_PASSWORD_ERRORS: ReadonlySet<string> = new Set([
  'missing_password_code',
  'EMAIL_CODE_INVALID',
  'EMAIL_CODE_NOT_SENT',
  'PASSWORD_ALREADY_SET',
  'AUTH_EMAIL_RECIPIENT_CAPPED',
]);

export function securityDoneCopy(done: string): string | null {
  return Object.prototype.hasOwnProperty.call(DONE_COPY, done) ? DONE_COPY[done]! : null;
}

function waitCopy(retryAfterSeconds: number | undefined): string {
  if (!retryAfterSeconds) return 'Too many attempts right now. Wait a few minutes, then try again.';
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts right now. Wait about ${minutes === 1 ? '1 minute' : `${minutes} minutes`}, then try again.`;
}

const ERROR_COPY: Readonly<Record<string, string>> = {
  missing: 'Fill in every field, then try again.',
  INVALID_CREDENTIALS:
    'That is not your current password. If you have never set one, create a password below instead.',
  missing_password_code: 'Enter the code from the email and a new password, then try again.',
  EMAIL_CODE_INVALID: 'That code is wrong or no longer works. Ask for a new code and enter the one in the newest email.',
  EMAIL_CODE_NOT_SENT: 'The code could not be emailed right now. Try again later, and if it keeps happening, contact the business that runs this account.',
  PASSWORD_ALREADY_SET: 'This account already has a password. Change it above with your current password.',
  PASSWORD_TOO_SHORT: 'That new password is too short. Choose a longer one.',
  PASSWORD_BREACHED: 'That new password appears in a known data breach. Choose a different one.',
  AUTH_METHOD_DISABLED: 'Password sign-in is turned off for this account, so there is no password to change.',
  MFA_CODE_INVALID: 'That code did not match. Enter the current 6-digit code from your authenticator app, or a backup code.',
  MFA_CODE_REUSED: 'That code was already used. Wait for the next code from your app, then enter it.',
  OAUTH_UNLINK_WOULD_LOCK_OUT:
    'That provider is the only way you can sign in, so it cannot be removed. Choose a password first, then remove it.',
  EMAIL_NOT_VERIFIED: 'Confirm your email address first. Use the confirmation link sent to your inbox.',
};

/**
 * @example
 * securityErrorCopy('OAUTH_UNLINK_WOULD_LOCK_OUT'); // 'That provider is the only way you can sign in, ...'
 */
export function securityErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code]!;
  if (
    code === 'RATE_LIMITED' ||
    code === 'TOO_MANY_FAILED_ATTEMPTS' ||
    code === 'MFA_TOO_MANY_ATTEMPTS' ||
    code === 'AUTH_EMAIL_RECIPIENT_CAPPED'
  ) {
    return waitCopy(retryAfterSeconds);
  }
  return 'That did not work. Try again, and if it keeps happening, contact the business that runs this account.';
}

/**
 * @example
 * backupCodesErrorCopy('MFA_CODE_INVALID'); // 'That code did not match. ...'
 */
export function backupCodesErrorCopy(code: string, retryAfterSeconds?: number): string {
  switch (code) {
    case 'missing':
      return 'Enter the 6-digit code from your authenticator app.';
    case 'MFA_CODE_INVALID':
      return 'That code did not match. Enter the current 6-digit code from your authenticator app. A backup code does not work here.';
    case 'MFA_CODE_REUSED':
      return 'That code was already used. Wait for the next code from your app, then enter it.';
    case 'MFA_NOT_ENROLLED':
      return 'Two-factor authentication is off, so there are no backup codes to replace. Reload the page.';
    case 'SESSION_EXPIRED':
      return 'Your session ended. Sign in again, then get new backup codes.';
    default:
      return securityErrorCopy(code, retryAfterSeconds);
  }
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { google: 'Google', github: 'GitHub', apple: 'Apple', microsoft: 'Microsoft' };

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/**
 * A session named by the browser and system its User-Agent reports.
 *
 * @example
 * sessionLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/130.0 Safari/537.36'); // 'Chrome on macOS'
 * sessionLabel(null); // 'Unknown browser'
 */
export function sessionLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown browser';
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? (system ? `A browser on ${system}` : 'Unknown browser');
}
