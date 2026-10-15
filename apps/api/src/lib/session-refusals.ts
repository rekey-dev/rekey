/**
 * The answers a session mint gives when the account moved on between the
 * credential check and the write (lib/session-basis.ts). Kept apart from the
 * services so the modules that mint sessions do not import one another.
 */

import { RekeyError } from './error.js';

/**
 * A sign-in whose proof was good when checked, on an account whose sessions
 * were all ended before the session could be written.
 *
 * @example
 *   sessionBasis(user, credentialSuperseded)
 */
export function credentialSuperseded(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'CREDENTIAL_SUPERSEDED',
    message: 'Every session on this account was ended while this sign-in was in progress, so no session was started.',
    fix: 'Sign in again from the start. A one-time link or code used by this attempt is spent: request a new one.',
  });
}

/** The operator twin of `credentialSuperseded`: same code, same remedy. */
export const operatorCredentialSuperseded = credentialSuperseded;

/**
 * A session-to-session mint by an operator whose sessions were all ended
 * after the request was admitted.
 *
 * @example
 *   { sessionsInvalidBefore: req.tenantSessionStamp ?? null, refusal: operatorSessionEndedMeanwhile }
 */
export function operatorSessionEndedMeanwhile(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'TENANT_SESSION_INVALID',
    message: 'Operator session was ended (password changed or signed out everywhere).',
    fix: 'Sign in again.',
  });
}
