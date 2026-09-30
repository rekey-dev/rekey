import { API_URL_MISSING_MESSAGES, normalizeErrorCode } from '@/lib/error-code';

/**
 * Banner copy for `/sign-up?error=<code>`. Only codes in this map render, so
 * the sign-up action passes every API code through `signUpErrorCode` first.
 */
export const SIGN_UP_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ...API_URL_MISSING_MESSAGES,
  missing: 'All fields are required.',
  EMAIL_ALREADY_EXISTS: 'That email is already registered. Sign in instead.',
  PASSWORD_TOO_SHORT: 'Password must be at least 8 characters.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  OPERATOR_SIGNUP_CLOSED: 'New operator registration is currently closed on this deployment.',
  OPERATOR_INVITE_REQUIRED: 'An invite key is required to sign up on this deployment.',
  OPERATOR_INVITE_INVALID: 'That invite key is not valid. Check it with whoever invited you.',
  OPERATOR_INVITE_USED: 'That invite key has already been used. Ask for a fresh one.',
  OPERATOR_INVITE_EXPIRED: 'That invite key has expired. Ask for a fresh one.',
  OPERATOR_INVITE_EMAIL_MISMATCH:
    'That invite was sent to a different email address. Sign up with the address it was sent to.',
  INTERNAL_ERROR: 'Something went wrong creating your workspace. Please try again.',
  BAD_REQUEST:
    'Check the details above. The workspace name, email, or password was rejected. Passwords need at least 8 characters.',
  VALIDATION_ERROR:
    'Check the details above. The workspace name, email, or password was rejected. Passwords need at least 8 characters.',
  // Catch-all the server action maps unrecognised API codes to, so a failure
  // never renders as a blank form. `?error=` is in the URL, so a value that
  // isn't in this map still renders nothing, a hand-crafted link can't paint
  // a fake error on a healthy form.
  unknown: 'Could not create your workspace. Please try again.',
};

/**
 * Narrow an API error code to one the sign-up page has copy for.
 *
 * @example
 * redirect(`/sign-up?error=${signUpErrorCode(err.code)}`);
 */
export function signUpErrorCode(code: string): string {
  return encodeURIComponent(normalizeErrorCode(code, SIGN_UP_ERROR_MESSAGES));
}
