/**
 * End-user session resolution.
 *
 * Used in addition to `requireApiKey` on routes that act on behalf of a
 * specific end-user (e.g. `GET /api/v1/users/me`). The calling server
 * passes the user's JWT in `X-Rekey-User-Token` (separate header from
 * `Authorization`, which carries the Application secret key).
 *
 * **Cross-application guard.** The JWT carries `applicationId`. We require
 * it match the Application that the calling secret key resolved to —
 * otherwise a token issued by Application A could be replayed against
 * Application B's data, breaking tenant isolation.
 *
 * On success, attaches `request.endUser` (PublicEndUser, no passwordHash).
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { RekeyError } from '../lib/error.js';
import { verifyUserAccessTokenAnyAlg } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import { authService, type PublicEndUser } from '../modules/auth/auth.service.js';

/** Who is really behind an impersonated session. Set only for `imp` tokens. */
export interface ImpersonationContext {
  /** `impersonation_audits.id` — the row that can end this session. */
  auditId: string;
  /** TenantUser id of the operator acting as the end-user. */
  operatorUserId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUserSession` after a valid user JWT is resolved. */
    endUser?: PublicEndUser;
    /**
     * The organization this session is acting in, if any.
     *
     * Derived from the token's `oid` claim but only set once membership has
     * been confirmed against the database, so it is true at request time
     * rather than at token-mint time. A member removed since the token was
     * issued reads as no active organization, not as a stale one.
     */
    activeOrganizationId?: string;
    /**
     * Present when this session is an OPERATOR impersonating the end-user
     * rather than the end-user themselves. Read by
     * `refuseWhileImpersonating` (middleware/impersonation.ts) to keep an
     * impersonated session out of the routes that rebind credentials.
     */
    impersonation?: ImpersonationContext;
  }
}

const TOKEN_HEADER = 'x-rekey-user-token';

export async function requireUserSession(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.application) {
    // Programming error — this hook must run after `requireApiKey`.
    throw new RekeyError({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'requireUserSession ran without an Application on the request.',
      fix: 'Register requireApiKey before requireUserSession on the route.',
    });
  }

  const tokenHeader = request.headers[TOKEN_HEADER];
  const presented = typeof tokenHeader === 'string' ? tokenHeader : '';
  if (!presented) {
    throw new RekeyError({
      statusCode: 401,
      code: 'USER_TOKEN_MISSING',
      message: 'This endpoint requires an X-Rekey-User-Token header (the user JWT).',
      fix: 'After sign-in, pass the returned `accessToken` to Rekey via the X-Rekey-User-Token header.',
    });
  }

  // Accepts HS256 (per-app derived key, the default) AND RS256 (deployment
  // JWKS key) — dispatched on the token header with a strict per-alg
  // allowlist; see verifyUserAccessTokenAnyAlg for the confusion-resistance
  // contract.
  const claims = await verifyUserAccessTokenAnyAlg(
    presented,
    request.application.id,
    request.application.tokenGeneration,
  );
  if (!claims) {
    throw new RekeyError({
      statusCode: 401,
      code: 'USER_TOKEN_INVALID',
      message: 'The user token is invalid, expired, or signed with a different secret.',
      fix: 'Have the user sign in again to obtain a fresh token.',
    });
  }

  if (claims.applicationId !== request.application.id) {
    // The token was issued by a different Application — refuse to act on it
    // even if the JWT signature is valid. This is the cross-tenant guard.
    throw new RekeyError({
      statusCode: 401,
      code: 'USER_TOKEN_WRONG_APPLICATION',
      message: 'The user token belongs to a different application.',
      fix: 'Issue a fresh token under the Application the calling secret key represents.',
    });
  }

  // An impersonation token names the audit row it belongs to (`impid`), and
  // that row is its revocation handle. Resolving it here is what makes the
  // session endable: an operator token used to be un-stoppable for its whole
  // 5-minute life because nothing on the request path ever looked at the audit
  // trail — `endedAt` was documented in the schema and written by no code path.
  //
  // A token carrying `imp` without a resolvable, still-open row is refused
  // rather than downgraded to an ordinary session. Both refusals are
  // deliberate: a missing `impid` is a token minted before impersonation
  // became revocable (they live 5 minutes, so the window is one deploy), and
  // treating either as a normal end-user session would silently strip the
  // operator attribution that the guards below depend on.
  if (claims.imp) {
    if (!claims.impid) throw impersonationEnded();
    const audit = await prisma.impersonationAudit.findUnique({
      where: { id: claims.impid },
      select: { endedAt: true, endUserId: true, applicationId: true, operatorUserId: true },
    });
    if (
      !audit ||
      audit.endedAt !== null ||
      audit.endUserId !== claims.sub ||
      audit.applicationId !== request.application.id ||
      // The DB row is the authority on WHO is impersonating, not the claim.
      // Forging `imp` needs the app signing key, so this is defence in depth —
      // but the whole point of resolving the row is that the audit trail and
      // the live session cannot disagree about who is acting.
      audit.operatorUserId !== claims.imp
    ) {
      throw impersonationEnded();
    }
    request.impersonation = { auditId: claims.impid, operatorUserId: audit.operatorUserId };
  }

  const endUser = await authService.getById(request.application.id, claims.sub);

  request.endUser = endUser;

  // The `oid` claim says which organization was active when the token was
  // minted, which is not the same as which one is active now: removing a member
  // does not and should not invalidate their access token. So the claim goes
  // stale, and until it expired `GET /users/me` kept reporting a removed
  // organization as active — a UI driving "current team" off that response
  // showed the wrong team and then 403'd on every call inside it.
  //
  // Same principle as the impersonation check above: the DB row is the
  // authority, the claim is a hint. Resolving it here rather than in each
  // handler means every consumer gets a value that is true right now —
  // `billing.routes.ts` was already paying for this check itself, which is why
  // authorization held; its check now becomes defence in depth rather than the
  // only thing standing between a removed member and org-scoped data.
  //
  // A stale claim drops the session to the personal view rather than failing
  // the request: being removed from an organization is not a reason to reject
  // an otherwise valid token.
  if (claims.oid) {
    // Straight at the `@@unique([organizationId, endUserId])` index, so this is
    // one indexed lookup on requests that carry an org — not a scan, and not
    // paid at all by sessions without one. The application check is belt and
    // braces: end-users are already per-Application, so a foreign org cannot
    // contain this one.
    const membership = await prisma.organizationMembership.findUnique({
      where: { organizationId_endUserId: { organizationId: claims.oid, endUserId: endUser.id } },
      select: { organization: { select: { applicationId: true } } },
    });
    if (membership?.organization.applicationId === request.application.id) {
      request.activeOrganizationId = claims.oid;
    }
  }
}

/**
 * One error for every reason an impersonation token is no longer usable —
 * ended, unknown, or bound to a different subject. Splitting them would let a
 * caller probe audit-row ids.
 */
function impersonationEnded(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'IMPERSONATION_SESSION_ENDED',
    message: 'This impersonation session has ended.',
    fix: 'Mint a fresh token via POST /api/v1/tenant/applications/:id/end-users/:userId/impersonate.',
  });
}
