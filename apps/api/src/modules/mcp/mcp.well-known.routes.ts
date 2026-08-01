/**
 * Root-level "path-insertion" OAuth / OIDC metadata discovery routes.
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
 * `openid-configuration` is served in BOTH forms for the opposite reason: OIDC
 * Discovery 1.0 §4 mandates the SUFFIX form (issuer + `/.well-known/...`, in
 * mcp.routes.ts), while RFC 8414 §3.1 defines the insertion form for the same
 * document — real relying-party libraries are split between the two, and a
 * provider that answers only one is unreachable from half of them.
 *
 * Registered at the ROOT (no prefix) in `app.ts` — the well-known segment must
 * sit directly under the origin, so this plugin cannot live under the
 * `/api/v1/mcp` prefix. Bodies are byte-identical to the suffix form and share
 * the same toggle-gated 404s.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  resolveMcpApp,
  resolveOidcApp,
  resolveAuthServerApp,
  authServerMetadata,
  openidConfiguration,
  protectedResourceMetadata,
} from './oauth.service.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

export async function mcpWellKnownRoutes(app: FastifyInstance): Promise<void> {
  // RFC 8414 — authorization-server metadata, path-insertion form. This is the
  // one a strict connector constructs from the issuer; the suffix form alone
  // 404s for it.
  app.get(
    '/.well-known/oauth-authorization-server/api/v1/mcp/:slug',
    {
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'OAuth authorization-server metadata (RFC 8414, path-insertion form)',
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveAuthServerApp(slug);
      return authServerMetadata(application);
    },
  );

  // OIDC Discovery 1.0, path-insertion form (RFC 8414 §3.1). Same document as
  // the suffix form in mcp.routes.ts.
  app.get(
    '/.well-known/openid-configuration/api/v1/mcp/:slug',
    {
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'OpenID Provider metadata (OIDC Discovery, path-insertion form)',
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveOidcApp(slug);
      return openidConfiguration(application);
    },
  );

  // RFC 9728 — protected-resource metadata, path-insertion form. Added for
  // spec-completeness alongside the 401 `WWW-Authenticate: resource_metadata`
  // pointer (which targets the suffix form).
  app.get(
    '/.well-known/oauth-protected-resource/api/v1/mcp/:slug',
    {
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'OAuth protected-resource metadata (RFC 9728, path-insertion form)',
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      await resolveMcpApp(slug);
      return protectedResourceMetadata(slug);
    },
  );
}
