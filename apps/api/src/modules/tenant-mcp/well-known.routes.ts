/**
 * Operator MCP root-level "path-insertion" OAuth metadata discovery routes.
 *
 * Mirrors `modules/mcp/mcp.well-known.routes.ts` for the operator MCP server.
 * A strict RFC 8414 / RFC 9728 client (e.g. Claude custom connectors) does NOT
 * append `.well-known/...` to the issuer's path. It CONSTRUCTS the metadata URL
 * by inserting the well-known segment right after the origin and re-appending
 * the issuer's path component:
 *
 *   issuer        = https://host/api/v1/tenant/mcp
 *   metadata URL  = https://host/.well-known/oauth-authorization-server/api/v1/tenant/mcp
 *
 * The suffix-form routes in `oauth.routes.ts`
 * (`/api/v1/tenant/mcp/.well-known/...`) 404 for that construction, so connector
 * setup fails with "Couldn't register with Relipay's sign-in service". These
 * routes serve the SAME metadata bodies at the path-insertion locations.
 *
 * Registered at the ROOT (no prefix) in `app.ts` — the well-known segment must
 * sit directly under the origin, so this plugin cannot live under the
 * `/api/v1/tenant/mcp` prefix. Gated by the same `OPERATOR_MCP_ENABLED` flag as
 * the rest of the operator MCP surface (the guard lives in `app.ts`).
 */

import type { FastifyInstance } from 'fastify';
import { operatorAuthServerMetadata, operatorProtectedResourceMetadata } from './oauth.service.js';

export async function operatorMcpWellKnownRoutes(app: FastifyInstance): Promise<void> {
  // RFC 8414 — authorization-server metadata, path-insertion form. This is the
  // one a strict connector constructs from the issuer; the suffix form alone
  // 404s for it.
  app.get(
    '/.well-known/oauth-authorization-server/api/v1/tenant/mcp',
    {
      schema: {
        tags: ['MCP · Operator · OAuth'],
        security: [],
        summary: 'Authorization-server metadata (RFC 8414, path-insertion form)',
      },
    },
    async () => operatorAuthServerMetadata(),
  );

  // RFC 9728 — protected-resource metadata, path-insertion form. Added for
  // spec-completeness alongside the 401 `WWW-Authenticate: resource_metadata`
  // pointer (which targets the suffix form).
  app.get(
    '/.well-known/oauth-protected-resource/api/v1/tenant/mcp',
    {
      schema: {
        tags: ['MCP · Operator · OAuth'],
        security: [],
        summary: 'Protected-resource metadata (RFC 9728, path-insertion form)',
      },
    },
    async () => operatorProtectedResourceMetadata(),
  );
}
