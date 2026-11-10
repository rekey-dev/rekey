/**
 * Words on the profile page: saving answers, changing the email address and
 * deleting the account.
 *
 * Pure and runtime-neutral: the page, the actions and tests import it.
 */

import { throttleCopy } from './auth-error-copy';

/** What the customer types to confirm deletion. */
export const DELETE_CONFIRMATION = 'DELETE';

export const PROFILE_SAVED_COPY = 'Your profile was saved.';
export const PROFILE_UNCHANGED_COPY = 'Nothing changed, so there was nothing to save.';
export const PROFILE_FIX_FIELDS_COPY = 'Some answers need fixing. Each one is marked below.';

/**
 * @example
 * profileSaveErrorCopy('PROFILE_TOO_LARGE'); // 'Those answers are too long to save. Shorten some of them.'
 */
export function profileSaveErrorCopy(code: string): string {
  if (code === 'PROFILE_TOO_LARGE') return 'Those answers are too long to save. Shorten some of them.';
  if (code === 'PROFILE_FIELD_UNKNOWN' || code === 'PROFILE_FIELD_READ_ONLY' || code === 'PROFILE_FIELD_INVALID') {
    return 'The questions changed while you were answering. Reload the page and try again.';
  }
  return 'Your profile could not be saved. Try again, and if it keeps happening, contact the business that runs this account.';
}

/** `?done=` after a deletion code was emailed. */
export const DELETE_CODE_SENT = 'delete_code_sent';

export const DELETE_CODE_SENT_COPY =
  'We emailed you a code. Choose Delete account and enter it there. It works once, for 10 minutes.';

/** `?done=` after an email change was asked for. The address itself never rides in the URL. */
export const EMAIL_CHANGE_SENT = 'email_change_sent';

export const EMAIL_CHANGE_SENT_COPY =
  'Check the inbox of the new address and open the link we sent there within an hour. Your address changes only when you confirm it. We also told your current address.';

export const EMAIL_CHANGED_COPY = 'Your email address is changed and you are signed out everywhere. Sign in with the new address.';

export function emailChangeConfirmPath(slug: string): string {
  return `/${slug}/profile/email`;
}

/**
 * @example
 * emailChangeErrorCopy('EMAIL_CHANGE_SAME_ADDRESS'); // 'That is already your email address.'
 */
export function emailChangeErrorCopy(code: string, retryAfterSeconds?: number): string {
  switch (code) {
    case 'missing':
      return 'Enter the new email address, then try again.';
    case 'EMAIL_CHANGE_SAME_ADDRESS':
      return 'That is already your email address.';
    case 'EMAIL_CHANGE_DOMAIN_NOT_ALLOWED':
      return 'This account cannot use an address at that domain. Choose another address.';
    case 'VALIDATION_ERROR':
      return 'That does not look like an email address. Check it and try again.';
    case 'EMAIL_CHANGE_NOT_SENT':
      return 'The confirmation email could not be sent right now, so nothing changed. Try again later.';
    case 'EMAIL_CHANGE_TOKEN_INVALID':
      return 'This link no longer works. It may have been used, be over an hour old, or have been replaced by a newer request or cancelled by a password change. Ask for the change again from your profile.';
    case 'EMAIL_CHANGE_PROOF_REQUIRED':
    case 'INVALID_CREDENTIALS':
      return 'Enter the current password of the account, or sign in to it first and then open the link again.';
    case 'EMAIL_ALREADY_EXISTS':
      return 'Another account already uses that address, so nothing changed.';
    case 'RATE_LIMITED':
    case 'TOO_MANY_FAILED_ATTEMPTS':
    case 'AUTH_EMAIL_RECIPIENT_CAPPED':
      return throttleCopy('RATE_LIMITED', retryAfterSeconds);
    default:
      return 'Your email address could not be changed. Try again, and if it keeps happening, contact the business that runs this account.';
  }
}

/**
 * Exactly what deleting does, from `DELETE /api/v1/users/me` and docs/data-erasure.md.
 *
 * @example
 * deleteAccountMessage('Acme'); // 'Your Acme account is deleted straight away and this cannot be undone. ...'
 */
export function deleteAccountMessage(appName: string): string {
  return (
    `Your ${appName} account is deleted straight away and this cannot be undone. You are signed out everywhere, and ` +
    'your email address, password, two-factor, sign-in providers, profile answers and devices are erased. Records ' +
    'of your payments and subscriptions are kept without your personal details, because the business must keep ' +
    'financial records.'
  );
}

/**
 * @example
 * deleteAccountErrorCopy('ACCOUNT_HAS_ACTIVE_SUBSCRIPTION', 'Acme'); // 'You have a subscription that is still billing. ...'
 */
export function deleteAccountErrorCopy(code: string, appName: string): string {
  switch (code) {
    case 'confirm_mismatch':
      return `Type ${DELETE_CONFIRMATION} in capitals to confirm. Your account was not deleted.`;
    case 'STEP_UP_REQUIRED':
      return 'That password or code was not right, so your account was not deleted.';
    case 'MFA_CODE_REUSED':
      return 'That code was already used. Wait for the next code from your app, then try again.';
    case 'EMAIL_CODE_REQUIRED':
      return 'This account has no password and no two-factor authentication, so confirm the deletion with an emailed code: choose Email me a code first.';
    case 'EMAIL_CODE_INVALID':
      return 'That code is wrong or no longer works, so your account was not deleted. Ask for a new code and enter the one in the newest email.';
    case 'EMAIL_CODE_NOT_ACCEPTED':
      return 'This account confirms deletion with its password or authenticator code, so no code was sent. Enter one of those instead.';
    case 'EMAIL_CODE_NOT_SENT':
      return 'The code could not be emailed right now. Try again later, and if it keeps happening, contact the business that runs this account.';
    case 'EMAIL_NOT_VERIFIED':
      return 'Confirm your email address first, using the confirmation link sent to your inbox, then ask for a code.';
    case 'ACCOUNT_HAS_ACTIVE_SUBSCRIPTION':
      return 'You have a subscription that is still billing. Cancel it on the Overview page first, then delete your account.';
    case 'ACCOUNT_SELF_DELETION_DISABLED':
      return `${appName} does not let accounts be deleted here. Contact ${appName} support to delete it.`;
    case 'RATE_LIMITED':
    case 'TOO_MANY_FAILED_ATTEMPTS':
    case 'AUTH_EMAIL_RECIPIENT_CAPPED':
      return 'Too many attempts right now. Wait a few minutes, then try again.';
    default:
      return 'Your account could not be deleted. Try again, and if it keeps happening, contact the business that runs this account.';
  }
}
