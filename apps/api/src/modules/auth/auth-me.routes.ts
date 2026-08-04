/**
 * GET /api/v1/auth/me
 *
 * Resolve the current end-user from ONLY the user access token
 * (`X-Rekey-User-Token`) — no Application secret key required.
 *
 * The access token is minted and signed by this API and carries
 * `{ sub, applicationId }`, so it is a sufficient credential for a read-only
 * "who am I" call (same posture as any bearer-token `/me`). This is the
 * endpoint browser SDKs (`@rekey.dev/react`) use, since the browser must never
 * hold the Application secret key.
 *
 * Registered as its own plugin (no `requireApiKey` hook) at the
 * `/api/v1/auth` prefix — the secret-key-guarded `/users/me` route still
 * exists for server-to-server callers that want the cross-app guard.
 */

import type { FastifyInstance } from 'fastify';
import { RekeyError } from '../../lib/error.js';
import { verifyUserAccessTokenAnyAlg, peekTokenApplicationId } from '../../lib/jwt.js';
import { prisma } from '../../lib/prisma.js';
import { authService } from './auth.service.js';
import { ok, errs, ref } from '../../lib/openapi.js';

const TOKEN_HEADER = 'x-rekey-user-token';

/**
 * This route reads only `X-Rekey-User-Token` — no Application key, no IP or
 * origin gate — so its error surface is just the token checks plus whatever
 * `authService.getById` (invoked at the bottom of the handler) can throw.
 */
const AUTH_ME_ERRORS = {
  401:
    'USER_TOKEN_MISSING — no X-Rekey-User-Token header; or USER_TOKEN_INVALID — the token is ' +
    'missing, expired, malformed, or the Application it names no longer exists.',
  404: 'END_USER_NOT_FOUND — the end-user behind this token no longer exists in this Application.',
  410: 'END_USER_ERASED — this end-user was erased (GDPR) and can no longer authenticate.',
  429: 'RATE_LIMITED — too many requests for this window. Honour the `Retry-After` header.',
} as const;

export async function userTokenMeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/me',
    {
      schema: {
        tags: ['Public · Auth'],
        security: [{ userToken: [] }],
        summary: 'Get the current end-user (from the user token alone)',
        description:
          'Resolves the end-user from the X-Rekey-User-Token JWT only — no Application secret ' +
          'key required. Intended for browser/client SDKs that hold only the user access token. ' +
          'Returns 401 USER_TOKEN_INVALID when the token is missing, expired, or malformed.',
        response: {
          // Same shape as GET /api/v1/users/me — see END_USER_SELF_SCHEMA in
          // routes/users-me.ts for why this `allOf` was unsatisfiable before
          // 2.0.0-rc.3 (closed `EndUser` component + a required field the
          // second branch added) and what the extra properties are.
          200: ok(
            {
              allOf: [
                ref('EndUser'),
                {
                  type: 'object',
                  properties: {
                    activeOrganizationId: {
                      type: 'string',
                      nullable: true,
                      description:
                        "The organization this session is acting for, from the token's `oid` " +
                        'claim. Null when the session has no active organization.',
                    },
                    role: {
                      type: 'string',
                      description: "The end-user's role within this Application.",
                    },
                    updatedAt: { type: 'string', format: 'date-time' },
                    erasedAt: {
                      type: 'string',
                      format: 'date-time',
                      nullable: true,
                      description:
                        'Set when the record was erased under GDPR. Null for a live user.',
                    },
                    erasedBy: { type: 'string', nullable: true },
                  },
                  required: ['activeOrganizationId', 'role', 'updatedAt'],
                },
              ],
            },
            "The current end-user, plus the session's active organization (if any).",
          ),
          ...errs({ ...AUTH_ME_ERRORS }),
        },
      },
    },
    async (req) => {
      const header = req.headers[TOKEN_HEADER];
      const presented = typeof header === 'string' ? header : '';
      if (!presented) {
        throw new RekeyError({
          statusCode: 401,
          code: 'USER_TOKEN_MISSING',
          message: 'This endpoint requires an X-Rekey-User-Token header (the user JWT).',
          fix: 'After sign-in, pass the returned `token` via the X-Rekey-User-Token header.',
        });
      }

      // End-user tokens are signed with a per-app derived key, so we need the
      // app's tokenGeneration to verify. Read the (unverified) applicationId
      // claim, load the app, then cryptographically verify — so the session
      // kill-switch (tokenGeneration bump) revokes these tokens here too.
      const invalid = new RekeyError({
        statusCode: 401,
        code: 'USER_TOKEN_INVALID',
        message: 'The user token is invalid, expired, or signed with a different secret.',
        fix: 'Have the user sign in again to obtain a fresh token.',
      });
      const appId = peekTokenApplicationId(presented);
      if (!appId) throw invalid;
      const application = await prisma.application.findUnique({
        where: { id: appId },
        select: { id: true, tokenGeneration: true },
      });
      if (!application) throw invalid;
      const claims = await verifyUserAccessTokenAnyAlg(
        presented,
        application.id,
        application.tokenGeneration,
      );
      if (!claims) throw invalid;

      const endUser = await authService.getById(claims.applicationId, claims.sub);
      return { success: true, data: { ...endUser, activeOrganizationId: claims.oid ?? null } };
    },
  );
}
