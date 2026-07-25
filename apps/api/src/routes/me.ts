/**
 * GET /api/v1/me
 *
 * The first endpoint a fresh `@relipay/node` client should call to verify
 * its credentials. Returns the Application the presented secret key resolves
 * to: `id`, `tenantId`, `name`, `slug`, `publicKey`, `createdAt`, and the
 * `authConfig` / `billingConfig` objects **whole** — not a filtered subset.
 *
 * That is deliberate and safe here, because this route requires an Application
 * secret key (`requireApiKey` rejects the publishable key), so the caller
 * already holds full server-side authority over this Application. But it is not
 * a "public-safe slice": do not proxy this response to a browser assuming it has
 * been redacted. Provider credentials and webhook secrets live in separate
 * encrypted columns and are never part of these two config objects, so no
 * secret material is returned — everything else in them is.
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
          'Use this as the SDK smoke test — if it returns 200, your secret key is good.\n\n' +
          'Requires an Application **secret** key with the `auth:read` scope; the publishable ' +
          'key is rejected. Returns the whole `authConfig` and `billingConfig` objects, not a ' +
          'filtered view — safe for the secret-key holder, but do not forward this response to ' +
          'a browser assuming it has been redacted. Provider, OAuth and email credentials live ' +
          'in separate encrypted columns and are never included.',
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
