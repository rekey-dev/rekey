/**
 * GET /api/v1/me
 *
 * The first endpoint a fresh `@relipay/node` client should call to verify
 * its credentials. Returns the Application the presented secret key resolves
 * to — `id`, `slug`, `name`, `publicKey`, and the public-safe slices of
 * `authConfig` and `billingConfig`.
 *
 * No secrets are returned. The caller already has the secret key in hand;
 * we don't need to echo more sensitive data back.
 */

import type { FastifyInstance } from 'fastify';
import type { Application } from '@prisma/client';
import { requireApiKey, requireScope } from '../middleware/api-key-auth.js';

function toApplicationDto(app: Application): {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  publicKey: string;
  authConfig: unknown;
  billingConfig: unknown;
  createdAt: string;
} {
  return {
    id: app.id,
    tenantId: app.tenantId,
    name: app.name,
    slug: app.slug,
    publicKey: app.publicKey,
    authConfig: app.authConfig,
    billingConfig: app.billingConfig,
    createdAt: app.createdAt.toISOString(),
  };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);
  // /me is the credential self-inspection endpoint — read-only.
  app.addHook('onRequest', requireScope('auth:read'));

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Me'],
        summary: 'Inspect the Application this credential resolves to',
        description:
          'Use this as the SDK smoke test — if it returns 200, your secret key is good. ' +
          'No secrets are returned in the response.',
        security: [{ apiKey: [] }],
      },
    },
    async (req) => {
      // requireApiKey guarantees both fields are set; the `!` is safe.
      return {
        success: true,
        data: toApplicationDto(req.application!),
      };
    },
  );
}
