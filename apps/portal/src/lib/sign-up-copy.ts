/**
 * What the sign-up page says for each outcome the API can answer with.
 *
 * Pure and runtime-neutral: the page, the action and the tests read it.
 */

import { isServiceFailure, isThrottle, throttleCopy } from './auth-error-copy';

export type SignUpField = 'email' | 'password';

export interface SignUpError {
  /** The input the message belongs under, or null for one about the whole form. */
  field: SignUpField | null;
  message: string;
  /** Offer a link to the sign-in page next to the message. */
  offerSignIn: boolean;
}

/**
 * Shown for every sign-up that needs the address confirmed, and for a filled
 * honeypot. With verification required the API answers a taken address the
 * same way as a new one and mails its owner instead, so this says only that
 * an email went out.
 */
export const SIGN_UP_SENT_COPY =
  'Check your inbox. We sent an email to that address with the next step. Open it to finish setting up your account.';

/** Shown on the sign-up page when the application only signs in with an emailed link. */
export const SIGN_UP_BY_LINK_COPY =
  'Enter your email address and we email you a link. Opening it creates your account and signs you in.';

const UNAVAILABLE =
  'Creating an account is not working on this site right now. This is not a problem with your email address. ' +
  'Try again later, and if it keeps happening, contact the business that runs this site.';

const SIGN_UP_OFF =
  'Creating an account here is turned off. If you already have an account, sign in.';

const KNOWN: Readonly<Record<string, SignUpError>> = {
  missing: { field: 'email', message: 'Enter your email address and a password.', offerSignIn: false },
  VALIDATION_ERROR: { field: 'email', message: 'Enter a valid email address.', offerSignIn: false },
  EMAIL_ALREADY_EXISTS: {
    field: 'email',
    message: 'You already have an account. Sign in instead.',
    offerSignIn: true,
  },
  SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED: {
    field: 'email',
    message: 'This email address cannot be used to create an account here. Use a different address.',
    offerSignIn: false,
  },
  PASSWORD_TOO_SHORT: {
    field: 'password',
    message: 'That password is too short. Choose a longer one.',
    offerSignIn: false,
  },
  PASSWORD_BREACHED: {
    field: 'password',
    message: 'That password appears in a known data breach. Choose a different one.',
    offerSignIn: false,
  },
  SIGNUP_DISABLED: { field: null, message: SIGN_UP_OFF, offerSignIn: true },
  SIGNUP_REQUIRES_SECRET_KEY: { field: null, message: SIGN_UP_OFF, offerSignIn: true },
  AUTH_METHOD_DISABLED: { field: null, message: SIGN_UP_OFF, offerSignIn: true },
  TENANT_QUOTA_EXCEEDED: {
    field: null,
    message: 'New accounts cannot be created here right now. Contact the business that runs this site.',
    offerSignIn: false,
  },
  DEVICE_FINGERPRINT_REQUIRED: {
    field: null,
    message: 'Accounts here are created in the app installed on your computer. Open the app to create yours.',
    offerSignIn: false,
  },
};

/**
 * @example
 * signUpErrorCopy('PASSWORD_BREACHED');
 * // { field: 'password', message: 'That password appears in a known data breach. Choose a different one.', offerSignIn: false }
 */
export function signUpErrorCopy(code: string, retryAfterSeconds?: number): SignUpError {
  const known = Object.prototype.hasOwnProperty.call(KNOWN, code) ? KNOWN[code] : undefined;
  if (known) return known;
  if (isThrottle(code)) return { field: null, message: throttleCopy(code, retryAfterSeconds), offerSignIn: false };
  if (isServiceFailure(code) || code === 'AUTH_URL_NOT_ALLOWED') {
    return { field: null, message: UNAVAILABLE, offerSignIn: false };
  }
  return {
    field: null,
    message:
      'Could not create your account. Try again, and if it keeps happening, contact the business that runs this site.',
    offerSignIn: false,
  };
}

/** The API answer that means "check your inbox": a new address and a taken one alike. */
export function isSignUpSent(code: string): boolean {
  return code === 'EMAIL_NOT_VERIFIED';
}
