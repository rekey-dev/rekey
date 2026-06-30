/**
 * OpenAPI / Swagger setup.
 *
 * Two consumers:
 *   1. **Humans** — open `/docs` in a browser to explore the API.
 *   2. **AI agents** — fetch `/docs/json` for a machine-readable schema.
 *
 * Keep `tags` consistent ("Admin · Tenants", "Admin · Applications", etc.) so
 * the docs UI groups routes intuitively. Every route should have at minimum
 * `summary` and ideally `description`.
 */

import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'ReliPay API',
        description:
          'Self-hostable authentication + billing + admin REST API. All money is in ' +
          'integer minor units (cents). Every error carries a `code`, human `message`, ' +
          'and a `fix`. Authenticate public routes with an Application secret key ' +
          '(`rp_live_…` / `rp_test_…`) in the `Authorization: Bearer` header; per-user ' +
          'routes also take the user JWT in `X-Relipay-User-Token`.',
        version: '0.1.0-beta.1',
      },
      servers: [
        { url: 'https://api.relipay.dev', description: 'Production' },
        { url: 'http://localhost:3030', description: 'Local development' },
      ],
      components: {
        securitySchemes: {
          superAdminKey: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Bootstrap admin credential (SUPER_ADMIN_KEY env var). Required for every /api/v1/admin/* route.',
          },
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Application-scoped secret key (rp_live_… or rp_test_…). Used by @relipay/node for the public API.',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}
