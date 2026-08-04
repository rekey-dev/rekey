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
 * setup fails with "Couldn't register with Rekey's sign-in service". These
 * routes serve the SAME metadata bodies at the path-insertion locations.
 *
 * Registered at the ROOT (no prefix) in `app.ts` — the well-known segment must
 * sit directly under the origin, so this plugin cannot live under the
 * `/api/v1/tenant/mcp` prefix. Gated by the same `OPERATOR_MCP_ENABLED` flag as
 * the rest of the operator MCP surface (the guard lives in `app.ts`).
 */

import type { FastifyInstance } from 'fastify';
import { operatorAuthServerMetadata, operatorProtectedResourceMetadata } from './oauth.service.js';
import { errs, ref, type JsonSchema } from '../../lib/openapi.js';

// This whole plugin only mounts when OPERATOR_MCP_ENABLED is on (see app.ts),
// so there is no per-request feature-toggle 404 to document — unlike the
// per-Application mirror (mcp.well-known.routes.ts), neither route here has a
// gate of its own INSIDE the handler. There is still a real 404, though: a
// deployment that turns the flag off unregisters this whole plugin, so both
// paths below fall through to `app.ts`'s generic `ROUTE_NOT_FOUND` handler —
// see `OPERATOR_MCP_DISABLED_404` in `oauth.routes.ts` (same reasoning,
// mirrored here rather than imported to keep this plugin dependency-free of
// that one). Bodies are RFC-shaped, not the Rekey envelope.
const OPERATOR_MCP_DISABLED_404 = {
  404:
    'ROUTE_NOT_FOUND — this deployment has `OPERATOR_MCP_ENABLED=false`, so the whole operator ' +
    'MCP surface (including this discovery document) does not exist.',
};

/** RFC 9728 protected-resource metadata. No registered component covers this shape. */
const ProtectedResourceMetadata: JsonSchema = {
  type: 'object',
  properties: {
    resource: { type: 'string', format: 'uri' },
    authorization_servers: { type: 'array', items: { type: 'string', format: 'uri' } },
    scopes_supported: { type: 'array', items: { type: 'string' } },
    bearer_methods_supported: { type: 'array', items: { type: 'string' } },
  },
  required: ['resource', 'authorization_servers'],
};

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
        response: {
          200: { description: 'Authorization-server metadata.', ...ref('OAuthAuthServerMetadata') },
          ...errs({
            ...OPERATOR_MCP_DISABLED_404,
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
        },
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
        response: {
          200: { description: 'Protected-resource metadata.', ...ProtectedResourceMetadata },
          ...errs({
            ...OPERATOR_MCP_DISABLED_404,
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
        },
      },
    },
    async () => operatorProtectedResourceMetadata(),
  );
}
