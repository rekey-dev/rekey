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

const TOKEN_HEADER = 'x-rekey-user-token';

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
