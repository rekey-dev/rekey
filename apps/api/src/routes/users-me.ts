/**
 * GET /api/v1/users/me
 *
 * Returns the EndUser identified by the JWT in `X-Relipay-User-Token`,
 * scoped to the Application identified by the secret key in `Authorization`.
 *
 * This is the SDK's per-user equivalent of `/api/v1/me` — the latter
 * returns the *Application*, this returns the *EndUser*.
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey, requireScope } from '../middleware/api-key-auth.js';
import { requireUserSession } from '../middleware/user-session.js';

export async function usersMeRoutes(app: FastifyInstance): Promise<void> {
  // Order matters: requireUserSession depends on request.application set by requireApiKey.
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireScope('auth:read'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Get the current end-user (resolved from the user JWT)',
        description:
          'Requires both the Application secret key (Authorization header) and the user JWT ' +
          '(X-Relipay-User-Token header). Refuses to return data if the JWT was issued by a ' +
          'different Application than the secret key represents.',
        security: [{ apiKey: [] }],
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
