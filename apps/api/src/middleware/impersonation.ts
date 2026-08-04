/**
 * Keep an impersonated session out of the routes that rebind credentials.
 *
 * Impersonation exists so an operator can SEE what a user sees — reproduce a
 * billing state, confirm an entitlement, work a support ticket. It was
 * implemented as an unrestricted session instead: the route's own comment said
 * "every route the user could call becomes callable as them, except routes that
 * explicitly refuse impersonation (none today)". With none, an operator (or
 * anyone who obtained the token, which is handed back over HTTP in a JSON body)
 * could enroll a passkey on the victim's account, re-bind their MFA to an
 * authenticator the operator controls, or change their password. Every one of
 * those outlives the 5-minute token permanently, and none of them is visible to
 * the user as anything but "my account changed".
 *
 * The bound on impersonation was only ever a lifetime. This is the missing half:
 * a set of actions the impersonated session cannot perform at all, no matter who
 * holds the token or how briefly.
 *
 * ## What is refused, and what is not
 *
 * Refused: anything that changes a credential, or the set of credentials, that
 * can sign the end-user in later — password, MFA enrollment/removal, passkey
 * enrollment/removal. These are the actions whose effect survives the token.
 *
 * Not refused: reads, billing, organization membership, and profile edits.
 * Those are the support work impersonation is for, they are already attributed
 * to the operator in `impersonation_audits`, and an operator can do them
 * through the panel anyway with a clearer audit trail.
 *
 * 403, not 401: the credential is valid and the session is live. The action is
 * the thing that is refused, and a 401 would make SDK clients tear down a
 * working session.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { RekeyError } from '../lib/error.js';

/**
 * `preHandler` that refuses the request when the caller is an operator
 * impersonating the end-user.
 *
 * @param action Short phrase naming what is refused, for the error message
 *   ("change this account's password").
 */
export function refuseWhileImpersonating(action: string) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.impersonation) return;
    throw new RekeyError({
      statusCode: 403,
      code: 'IMPERSONATION_ACTION_FORBIDDEN',
      message: `An impersonation session cannot ${action}.`,
      fix:
        'Credential changes are refused while impersonating — they would outlive the ' +
        '5-minute token and the user could not tell who made them. Ask the user to perform ' +
        'this themselves, or act through the operator panel.',
    });
  };
}
