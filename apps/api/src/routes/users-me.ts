/**
 * GET /api/v1/users/me
 *
 * Returns the EndUser identified by the JWT in `X-Rekey-User-Token`, scoped to
 * the Application identified by the key in `Authorization`.
 *
 * This is the per-user counterpart to `/api/v1/me`, which returns the
 * *Application*. The two have deliberately DIFFERENT credential tiers, and the
 * difference is the point:
 *
 *   - This route takes the publishable key, because the end-user session is the
 *     authorizer and the response is that user's own record. A browser-only app
 *     reading its signed-in user's profile is the whole use case.
 *   - `/api/v1/me` stays secret-key-only, because it returns the Application's
 *     entire `authConfig` and `billingConfig`. Those are operator configuration,
 *     not user data, and handing them to anything holding a browser-shipped key
 *     would disclose the app's auth policy and billing setup.
 *
 * Nothing here needs redacting for a browser: `authService.getById` returns a
 * `PublicEndUser` (`passwordHash` stripped), and an erased user is rejected
 * before this handler runs, so `erasedBy` is always null on this path.
 */

import type { FastifyInstance } from 'fastify';
import { requirePublishableOrSecretKey, requireScope } from '../middleware/api-key-auth.js';
import { requireUserSession } from '../middleware/user-session.js';

export async function usersMeRoutes(app: FastifyInstance): Promise<void> {
  // Order matters: requireUserSession depends on request.application, which the
  // key hook sets.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  // No-ops for a publishable request by design — a publishable key carries no
  // scopes, so route membership plus the session is what constrains it.
  app.addHook('onRequest', requireScope('auth:read'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Get the current end-user (resolved from the user JWT)',
        description:
          'Requires an Application key (publishable or secret, Authorization header) AND the ' +
          'user JWT (X-Rekey-User-Token header). Callable from a browser with the publishable ' +
          'key, since the JWT is the authorizer and the response is that user\'s own record. ' +
          'Refuses to return data if the JWT was issued by a different Application than the ' +
          'key represents. Note `GET /api/v1/me` is different: it returns the Application, ' +
          'including its whole authConfig and billingConfig, so it stays secret-key-only.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
      },
    },
    async (req) => {
      return {
        success: true,
        data: { ...req.endUser!, activeOrganizationId: req.activeOrganizationId ?? null },
      };
    },
  );
}
