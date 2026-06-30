/**
 * End-user session resolution.
 *
 * Used in addition to `requireApiKey` on routes that act on behalf of a
 * specific end-user (e.g. `GET /api/v1/users/me`). The calling server
 * passes the user's JWT in `X-Relipay-User-Token` (separate header from
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
import { RelipayError } from '../lib/error.js';
import { verifyUserAccessTokenAnyAlg } from '../lib/jwt.js';
import { authService, type PublicEndUser } from '../modules/auth/auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUserSession` after a valid user JWT is resolved. */
    endUser?: PublicEndUser;
    /**
     * Active organization id from the token's `oid` claim, if any. Routes that
     * default a subject to the active org read this (membership is re-confirmed
     * before it's honored — a stale claim never grants access).
     */
    activeOrganizationId?: string;
  }
}

const TOKEN_HEADER = 'x-relipay-user-token';

export async function requireUserSession(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.application) {
    // Programming error — this hook must run after `requireApiKey`.
    throw new RelipayError({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'requireUserSession ran without an Application on the request.',
      fix: 'Register requireApiKey before requireUserSession on the route.',
    });
  }

  const tokenHeader = request.headers[TOKEN_HEADER];
  const presented = typeof tokenHeader === 'string' ? tokenHeader : '';
  if (!presented) {
    throw new RelipayError({
      statusCode: 401,
      code: 'USER_TOKEN_MISSING',
      message: 'This endpoint requires an X-Relipay-User-Token header (the user JWT).',
      fix: 'After sign-in, pass the returned `token` to ReliPay via the X-Relipay-User-Token header.',
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
    throw new RelipayError({
      statusCode: 401,
      code: 'USER_TOKEN_INVALID',
      message: 'The user token is invalid, expired, or signed with a different secret.',
      fix: 'Have the user sign in again to obtain a fresh token.',
    });
  }

  if (claims.applicationId !== request.application.id) {
    // The token was issued by a different Application — refuse to act on it
    // even if the JWT signature is valid. This is the cross-tenant guard.
    throw new RelipayError({
      statusCode: 401,
      code: 'USER_TOKEN_WRONG_APPLICATION',
      message: 'The user token belongs to a different application.',
      fix: 'Issue a fresh token under the Application the calling secret key represents.',
    });
  }

  const endUser = await authService.getById(request.application.id, claims.sub);

  // Test/live isolation chokepoint (roadmap §7): every end-user-scoped route
  // runs through here, so a single check makes TEST users invisible to live
  // keys and vice versa — even with a perfectly valid user JWT.
  if (request.dataMode && endUser.mode !== request.dataMode) {
    throw new RelipayError({
      statusCode: 403,
      code: 'DATA_MODE_MISMATCH',
      message:
        `This user belongs to ${endUser.mode === 'TEST' ? 'test' : 'live'} mode, but the calling ` +
        `secret key is a ${request.dataMode === 'TEST' ? 'test' : 'live'} key. Test and live data are isolated.`,
      fix: 'Use a secret key of the matching mode (rp_test_… for test users, rp_live_… for live users).',
    });
  }

  request.endUser = endUser;
  if (claims.oid) request.activeOrganizationId = claims.oid;
}
