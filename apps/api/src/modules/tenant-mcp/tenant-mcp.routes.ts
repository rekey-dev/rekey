/**
 * Operator-side MCP routes mounted at `/api/v1/tenant/mcp`.
 *
 * Auth (Phase 1): Bearer operator personal-access-token (`rp_op_…`). The
 * existing `resolveOperatorToken` middleware verifies the token, decorates
 * `req.tenantUser` / `req.tenantId` / `req.tenantRole`, and re-checks the
 * operator's membership against the DB on every request — so a PAT minted
 * while an operator was a workspace member stops working the moment they're
 * removed. Phase 2 will layer an OAuth 2.1 + PKCE authorization server on
 * top so an MCP client can drive the browser flow; the JSON-RPC dispatch
 * + tool surface stay identical.
 *
 * The MCP endpoint accepts a single JSON-RPC 2.0 message (object body) per
 * POST and responds with `application/json` — the Streamable HTTP transport
 * shape MCP clients negotiate. GET on the same URL returns 405 + an `Allow:
 * POST` hint so curl-typers see the explicit method violation rather than a
 * silent 404.
 *
 * Security:
 *   - No new auth surface. Every request must already present a valid
 *     operator PAT; the JSON-RPC layer never authenticates by itself.
 *   - Tools are READ-ONLY. The handler never calls a Prisma method that
 *     mutates state; a future write tool would need its own scope check.
 *   - PAT scope is honored: this surface requires `read` (the default
 *     scope every PAT has). Write tools, if/when added, MUST guard
 *     themselves with `requireOperatorScope('…:write')`.
 *   - Workspace scoping is structural: the PAT is bound to one workspace
 *     (`TenantApiToken.tenantId`), so the tools' (tenantUserId, tenantId)
 *     context is the only thing they can ever see.
 */

import type { FastifyInstance } from 'fastify';
import { RelipayError } from '../../lib/error.js';
import { resolveOperatorMcpBearer } from './bearer-auth.js';
import { operatorMcpIssuer } from './oauth.service.js';
import { handleOperatorMcpMessage, type JsonRpcMessage } from './tenant-mcp-server.js';

export async function tenantMcpRoutes(app: FastifyInstance): Promise<void> {
  // Hybrid Bearer guard: accepts either an operator PAT (`rp_op_…`, Phase 1)
  // or an OAuth-issued JWT (`typ: 'op_mcp_access'`, Phase 2). Both paths
  // re-check the operator's workspace membership on every request, populate
  // `req.tenantUser` + `req.tenantId` + `req.tenantRole` identically, and 401
  // uniformly on any failure (no information disclosure).
  app.addHook('onRequest', resolveOperatorMcpBearer);

  /**
   * Single MCP entry point. The client POSTs a JSON-RPC message; we dispatch
   * to `handleOperatorMcpMessage` which returns either a response object or
   * `null` (notifications get no reply, JSON-RPC §4.1).
   */
  app.post(
    '/',
    {
      schema: {
        tags: ['MCP · Operator'],
        summary: 'Operator MCP JSON-RPC endpoint',
        description:
          'Single JSON-RPC 2.0 POST. Requires Authorization: Bearer rp_op_… ' +
          '(operator PAT). Tools are scoped to the PAT\'s bound workspace.',
      },
    },
    async (req, reply) => {
      // Decorations from `resolveOperatorToken`. Guard against any future
      // misconfiguration that would bypass auth (defence in depth — the
      // hook above already 401s on failure).
      if (!req.tenantUser || !req.tenantId) {
        throw new RelipayError({
          statusCode: 401,
          code: 'OPERATOR_MCP_UNAUTHORIZED',
          message: 'Operator MCP authentication did not populate the request.',
          fix: 'Ensure the request carries Authorization: Bearer …',
        });
      }
      // Add the WWW-Authenticate hint pointing at protected-resource metadata
      // so clients can run the discovery cascade — but only on success replies
      // since an unauthed call already 401s before this handler. Skipped here.
      reply.header('WWW-Authenticate', `Bearer resource_metadata="${operatorMcpIssuer()}/.well-known/oauth-protected-resource"`);
      const msg = (req.body ?? {}) as JsonRpcMessage;
      const response = await handleOperatorMcpMessage(
        { tenantUserId: req.tenantUser.id, tenantId: req.tenantId },
        msg,
      );
      // JSON-RPC notifications get no reply (no `id`). 204 communicates
      // "received, nothing to say."
      if (response === null) return reply.status(204).send();
      return reply.type('application/json').send(response);
    },
  );

  // GET-on-MCP-URL is a common typing mistake; return 405 with the
  // expected method so the operator sees the obvious fix rather than
  // a generic 404 or "Method not allowed" from Fastify's default.
  app.get('/', async (_req, reply) => {
    reply
      .code(405)
      .header('Allow', 'POST')
      .send({
        success: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message:
            'The MCP endpoint accepts JSON-RPC 2.0 over POST only. ' +
            'GET is rejected so curl-typers see the violation explicitly.',
          fix: 'POST a JSON-RPC body with Authorization: Bearer rp_op_… instead.',
        },
      });
  });
}
