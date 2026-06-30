/**
 * Root-level "path-insertion" OAuth metadata discovery routes.
 *
 * A strict RFC 8414 / RFC 9728 client (e.g. Claude custom connectors) does NOT
 * append `.well-known/...` to the issuer's path. It CONSTRUCTS the metadata URL
 * by inserting the well-known segment right after the origin and re-appending
 * the issuer's path component:
 *
 *   issuer        = https://host/api/v1/mcp/{slug}
 *   metadata URL  = https://host/.well-known/oauth-authorization-server/api/v1/mcp/{slug}
 *
 * The suffix-form routes in `mcp.routes.ts`
 * (`/api/v1/mcp/{slug}/.well-known/...`) 404 for that construction, so connector
 * setup fails. These routes serve the SAME metadata bodies at the
 * path-insertion locations.
 *
 * Registered at the ROOT (no prefix) in `app.ts` — the well-known segment must
 * sit directly under the origin, so this plugin cannot live under the
 * `/api/v1/mcp` prefix. Bodies are byte-identical to the suffix form and share
 * the same `mcpEnabled`-gated 404 (via `resolveMcpApp`).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  resolveMcpApp,
  authServerMetadata,
  protectedResourceMetadata,
} from './oauth.service.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

export async function mcpWellKnownRoutes(app: FastifyInstance): Promise<void> {
  // RFC 8414 — authorization-server metadata, path-insertion form. This is the
  // one a strict connector constructs from the issuer; the suffix form alone
  // 404s for it.
  app.get(
    '/.well-known/oauth-authorization-server/api/v1/mcp/:slug',
    { schema: { tags: ['MCP · OAuth'], summary: 'OAuth authorization-server metadata (RFC 8414, path-insertion form)' } },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      await resolveMcpApp(slug);
      return authServerMetadata(slug);
    },
  );

  // RFC 9728 — protected-resource metadata, path-insertion form. Added for
  // spec-completeness alongside the 401 `WWW-Authenticate: resource_metadata`
  // pointer (which targets the suffix form).
  app.get(
    '/.well-known/oauth-protected-resource/api/v1/mcp/:slug',
    { schema: { tags: ['MCP · OAuth'], summary: 'OAuth protected-resource metadata (RFC 9728, path-insertion form)' } },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      await resolveMcpApp(slug);
      return protectedResourceMetadata(slug);
    },
  );
}
