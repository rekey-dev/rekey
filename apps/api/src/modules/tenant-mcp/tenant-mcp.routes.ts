/**
 * Operator-side MCP routes mounted at `/api/v1/tenant/mcp`.
 *
 * Auth: `resolveOperatorMcpBearer` (see `bearer-auth.ts`) accepts EITHER
 * credential on `Authorization: Bearer` —
 *
 *   1. an operator personal-access-token (`rp_op_…`) carrying the `read` scope
 *      (Phase 1), or
 *   2. an OAuth-issued access JWT (`typ: 'op_mcp_access'`) minted by this
 *      deployment's operator-MCP authorization server (Phase 2, already live —
 *      see `oauth.routes.ts` in this directory).
 *
 * One bearer at a time; credentials are never chained. Both paths decorate
 * `req.tenantUser` / `req.tenantId` / `req.tenantRole` identically, re-check the
 * operator's membership against the DB on every request — so a credential
 * minted while an operator was a workspace member stops working the moment
 * they're removed — and 401 uniformly on any failure.
 *
 * The MCP endpoint accepts a single JSON-RPC 2.0 message (object body) per
 * POST and responds with `application/json` — the Streamable HTTP transport
 * shape MCP clients negotiate. GET on the same URL returns 405 + an `Allow:
 * POST` hint so curl-typers see the explicit method violation rather than a
 * silent 404.
 *
 * Security:
 *   - No new auth surface. Every request must already present a valid operator
 *     PAT **or** OAuth access token; the JSON-RPC layer never authenticates by
 *     itself.
 *   - Read tools are always available. WRITE tools (phase 1: create/edit
 *     applications, plans, auth-config, webhook endpoints) are gated by the
 *     dispatcher: the token must carry write capability (`mcp:operator:write`
 *     for OAuth, `applications:write` for a PAT) AND the operator's role must
 *     clear the tool's minimum (default ADMIN). The gate filters `tools/list`
 *     and re-checks at `tools/call`, and every write handler re-scopes by
 *     tenant. Two tools (`configure_billing_provider`, `cancel_subscription`) are
 *     flagged `admin`, so they need `mcp:operator:admin` on top of write.
 *   - Scope is honored: this surface requires `read` (or `mcp:operator:read`) to
 *     authenticate; a PAT additionally needs `applications:write`, and an OAuth
 *     token `mcp:operator:write`, to reach the write tools.
 *   - Workspace scoping: a PAT is pinned to one workspace
 *     (`TenantApiToken.tenantId`); an OAuth token carries the consented `tid`.
 *     Either way the isolation is each handler filtering on `ctx.tenantId` —
 *     a convention to uphold, not a structural guarantee.
 */

import type { FastifyInstance } from 'fastify';
import { RekeyError } from '../../lib/error.js';
import { requestContext } from '../../lib/security-events.js';
import { resolveOperatorMcpBearer } from './bearer-auth.js';
import { scopeHasWrite, scopeHasAdmin } from './oauth.service.js';
import { handleOperatorMcpMessage, type JsonRpcMessage } from './tenant-mcp-server.js';
import { errs, type JsonSchema } from '../../lib/openapi.js';

// This whole plugin only mounts when OPERATOR_MCP_ENABLED is on (see app.ts) —
// there is no per-request feature-toggle 404 to document here, unlike the
// per-Application MCP module. The `onRequest` hook (`resolveOperatorMcpBearer`)
// runs before every handler in this file and throws the Rekey-enveloped 401
// below on any auth failure.

const AUTH_401 = {
  401:
    'OPERATOR_MCP_UNAUTHORIZED — no `Authorization: Bearer` header, or the presented PAT / ' +
    'OAuth access token is unknown, revoked, expired, wrong-audience, or belongs to an ' +
    'operator no longer a member of the token\'s workspace.',
};

const JsonRpcSuccess: JsonSchema = {
  type: 'object',
  properties: {
    jsonrpc: { type: 'string', enum: ['2.0'] },
    id: { description: 'Echoes the request id — string, number, or null.' },
    result: {
      description:
        'Present on success. Shape depends on the method (initialize / tools/list / tools/call / ping).',
    },
  },
  required: ['jsonrpc', 'id', 'result'],
};

const JsonRpcFailure: JsonSchema = {
  type: 'object',
  properties: {
    jsonrpc: { type: 'string', enum: ['2.0'] },
    id: { description: 'Echoes the request id — string, number, or null.' },
    error: {
      type: 'object',
      properties: { code: { type: 'integer' }, message: { type: 'string' } },
      required: ['code', 'message'],
    },
  },
  required: ['jsonrpc', 'id', 'error'],
};

/**
 * Unlike the per-Application MCP endpoint, this route accepts one JSON-RPC
 * message per POST (never a batch array) — see `handleOperatorMcpMessage`,
 * which takes a single `JsonRpcMessage`.
 */
const JsonRpcResponse: JsonSchema = {
  description: 'A single JSON-RPC 2.0 response — a `result` or an `error`, never both.',
  oneOf: [JsonRpcSuccess, JsonRpcFailure],
};

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
        security: [{ mcpAccessToken: [] }],
        summary: 'Operator MCP JSON-RPC endpoint',
        description:
          'Single JSON-RPC 2.0 POST. `Authorization: Bearer` accepts **either** credential:\n\n' +
          '- an operator personal-access-token (`rp_op_…`) that carries the `read` scope, or\n' +
          '- an OAuth-issued access JWT (`typ: op_mcp_access`) from this deployment’s ' +
          'operator-MCP authorization server (start at `GET /api/v1/tenant/mcp/oauth/authorize`).\n\n' +
          'One bearer at a time; credentials are never chained. Either way, the operator’s ' +
          'workspace membership is re-checked against the database on every request, and the ' +
          'tools can only ever see that one workspace.\n\n' +
          '**Read tools** need nothing beyond authenticating. **Write tools** additionally ' +
          'require write capability on the presented credential — `mcp:operator:write` in the ' +
          'OAuth scope, or the `applications:write` scope on a PAT — AND an operator role that ' +
          'clears the tool’s floor (ADMIN by default). The gate filters `tools/list` as well as ' +
          '`tools/call`, so an under-privileged credential does not even see them. ' +
          'Destructive / financial tools are gated further on `mcp:operator:admin`, which only ' +
          'the OAuth path can carry — a PAT can never reach them.',
        response: {
          200: { description: 'JSON-RPC response.', ...JsonRpcResponse },
          204: {
            description: 'The request was a JSON-RPC notification (no `id`) — accepted, no reply body.',
          },
          ...errs(AUTH_401),
        },
      },
    },
    async (req, reply) => {
      // Decorations from `resolveOperatorToken`. Guard against any future
      // misconfiguration that would bypass auth (defence in depth — the
      // hook above already 401s on failure).
      if (!req.tenantUser || !req.tenantId) {
        throw new RekeyError({
          statusCode: 401,
          code: 'OPERATOR_MCP_UNAUTHORIZED',
          message: 'Operator MCP authentication did not populate the request.',
          fix: 'Ensure the request carries Authorization: Bearer …',
        });
      }
      // `WWW-Authenticate` is set in the auth hook before it can throw, so it
      // rides every 401 as well as this success reply. It used to be set only
      // here, which meant the one response that needed it never carried it.
      //
      // Write capability is whichever the resolved credential carries:
      //   - OAuth JWT: the granted `scope` string includes `mcp:operator:write`.
      //   - PAT: the token's scopes include `applications:write`.
      // Role is the LIVE membership role the auth guard re-checked this request.
      const canWrite = req.operatorMcpClaims
        ? scopeHasWrite(req.operatorMcpClaims.scope)
        : (req.operatorTokenScopes ?? []).includes('applications:write');
      // Admin (destructive/financial) is OAuth-scope-only — a PAT never carries
      // it. An operator must run the OAuth consent flow and grant
      // `mcp:operator:admin` explicitly for these tools to be reachable.
      const canAdmin = req.operatorMcpClaims
        ? scopeHasAdmin(req.operatorMcpClaims.scope)
        : false;
      const { ip, userAgent } = requestContext(req);
      const msg = (req.body ?? {}) as JsonRpcMessage;
      const response = await handleOperatorMcpMessage(
        {
          tenantUserId: req.tenantUser.id,
          tenantId: req.tenantId,
          role: req.tenantRole ?? 'MEMBER',
          // Both auth paths in bearer-auth.ts set this. It is what the read
          // tools resolve a MEMBER's per-Application grants from; absent, they
          // fail closed rather than serving the whole workspace.
          tenantMembershipId: req.tenantMembershipId,
          canWrite,
          canAdmin,
          ip,
          userAgent,
        },
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
  app.get(
    '/',
    {
      schema: {
        tags: ['MCP · Operator'],
        security: [{ mcpAccessToken: [] }],
        summary: 'Operator MCP endpoint — use POST (JSON-RPC)',
        description:
          'Always 405 with `Allow: POST`. Still authenticated: the plugin-level Bearer hook ' +
          'runs first, so an unauthenticated GET gets 401 rather than this 405.',
        response: {
          // NOTE: hand-rolled in the handler as `{success: false, error: {code, message,
          // fix}}` — the shape of the Rekey envelope, but WITHOUT the `requestId` field
          // every other error response carries (it isn't built via RekeyError/the error
          // handler, just written inline). Declared literally rather than via
          // `ref('ErrorResponse')`/`errs()`, which would incorrectly promise a
          // `requestId`. See the report for this file.
          405: {
            description: 'METHOD_NOT_ALLOWED — use POST for MCP JSON-RPC.',
            type: 'object',
            properties: {
              success: { type: 'boolean', enum: [false] },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', enum: ['METHOD_NOT_ALLOWED'] },
                  message: { type: 'string' },
                  fix: { type: 'string' },
                },
                required: ['code', 'message', 'fix'],
              },
            },
            required: ['success', 'error'],
          },
          ...errs(AUTH_401),
        },
      },
    },
    async (_req, reply) => {
      // Set the header, then THROW — a hand-built `reply.send({ success:
      // false, error: {...} })` never reaches `rekeyErrorHandler` and so
      // omits `requestId`. Headers already on the reply survive the throw.
      reply.header('Allow', 'POST');
      throw new RekeyError({
        statusCode: 405,
        code: 'METHOD_NOT_ALLOWED',
        message:
          'The MCP endpoint accepts JSON-RPC 2.0 over POST only. ' +
          'GET is rejected so curl-typers see the violation explicitly.',
        fix: 'POST a JSON-RPC body with Authorization: Bearer rp_op_… instead.',
      });
    },
  );
}
