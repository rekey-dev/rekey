/**
 * What the profile questions page says. Pure and runtime-neutral.
 */

import { isServiceFailure, isThrottle, throttleCopy } from './auth-error-copy';

export const PROFILE_COMPLETE_INTRO = 'Answer a few questions to finish setting up your account.';

/** Announced above the form when answers came back refused; each reason sits under its question. */
export const PROFILE_ANSWERS_REFUSED_COPY = 'Some answers need a change before you can continue. Each one is marked below.';

/**
 * @example
 * profileSaveErrorCopy('RATE_LIMITED', 60); // 'Too many attempts right now. Wait about a minute, then try again.'
 */
export function profileSaveErrorCopy(code: string, retryAfterSeconds?: number): string {
  if (code === 'PROFILE_FIELD_UNKNOWN' || code === 'PROFILE_FIELD_READ_ONLY' || code === 'PROFILE_FIELD_INVALID') {
    return 'These questions changed while you were answering. Reload the page and answer them again.';
  }
  if (code === 'PROFILE_TOO_LARGE') return 'Your answers are too long to save. Shorten them and try again.';
  if (isThrottle(code)) return throttleCopy(code, retryAfterSeconds);
  if (isServiceFailure(code)) {
    return (
      'Your answers could not be saved right now. This is not a problem with your account. Try again later, ' +
      'and if it keeps happening, contact the business that runs this account.'
    );
  }
  return 'Your answers could not be saved. Reload the page and try again.';
}
