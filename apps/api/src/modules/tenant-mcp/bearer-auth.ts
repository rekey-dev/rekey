/**
 * Hybrid Bearer guard for the operator MCP JSON-RPC endpoint.
 *
 * Accepts EITHER:
 *   1. An operator personal-access-token (`rp_op_…`) — Phase 1 mechanism.
 *      Verified by the same code path that gates `/api/v1/tenant/operator/*`
 *      (membership re-checked on every request, scope must include `read`).
 *   2. An OAuth-issued access JWT (`typ: 'op_mcp_access'`) — Phase 2.
 *      Verified by `verifyOperatorMcpAccessToken`. Audience must be the
 *      operator-MCP issuer URL. Membership is re-checked on every request,
 *      same invariant as the PAT path.
 *
 * On success the request is decorated identically (`req.tenantUser`,
 * `req.tenantId`, `req.tenantRole`, `req.operatorTokenScopes` or
 * `req.operatorMcpClaims`) so the JSON-RPC handler reads the same fields
 * regardless of which auth path resolved the request.
 *
 * Security:
 *   - One Bearer at a time (no chained credentials).
 *   - Generic 401 on any failure — unknown / revoked / expired tokens are
 *     indistinguishable to a caller.
 *   - Membership re-check on every request stops a token minted while the
 *     operator was a workspace member from working after their role was
 *     revoked or they were removed.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TenantRole } from '@prisma/client';
import { RekeyError } from '../../lib/error.js';
import { prisma } from '../../lib/prisma.js';
import { hashOperatorToken, isOperatorToken } from '../../lib/operator-token.js';
import {
  verifyOperatorMcpAccessToken,
  type OperatorMcpAccessClaims,
} from '../../lib/operator-mcp-jwt.js';
import { operatorMcpIssuer } from './oauth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on OAuth-JWT auth path; absent when authenticated by a PAT. */
    operatorMcpClaims?: OperatorMcpAccessClaims;
  }
}

function unauthorized(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'OPERATOR_MCP_UNAUTHORIZED',
    message: 'Operator MCP requires Authorization: Bearer rp_op_… (PAT) OR an OAuth access token.',
    fix:
      'Mint a PAT at POST /api/v1/tenant/auth/api-tokens, or run the OAuth flow at ' +
      'GET /api/v1/tenant/mcp/oauth/authorize (your MCP client will do this for you).',
  });
}

/**
 * `onRequest` hook for the operator MCP endpoint. Routes a presented Bearer
 * down whichever path matches its prefix. Decorates the request like
 * `resolveOperatorToken` so the JSON-RPC handler is auth-mechanism-agnostic.
 */
export async function resolveOperatorMcpBearer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Set the discovery hint BEFORE any throw. Every 401 out of this hook is a
  // client that has not yet found the authorization server, and RFC 9728 (which
  // the MCP spec makes a MUST) says the 401 itself is what points them at it.
  //
  // This used to be set only on the success reply in tenant-mcp.routes.ts, on
  // the reasoning that "an unauthed call already 401s before this handler" —
  // which is exactly true and exactly backwards: the one response that needed
  // the header was the only one that never got it. A spec-compliant client
  // could not discover the operator MCP at all, and Claude specifically will
  // not honour the header on a 200.
  reply.header(
    'WWW-Authenticate',
    `Bearer resource_metadata="${operatorMcpIssuer()}/.well-known/oauth-protected-resource"`,
  );

  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) throw unauthorized();

  if (isOperatorToken(presented)) {
    await resolveByPat(request, presented);
    return;
  }
  await resolveByOAuthJwt(request, presented);
}

async function resolveByPat(request: FastifyRequest, raw: string): Promise<void> {
  const token = await prisma.tenantApiToken.findUnique({
    where: { tokenHash: hashOperatorToken(raw) },
  });
  if (!token || token.revokedAt !== null) throw unauthorized();
  if (token.expiresAt !== null && token.expiresAt <= new Date()) throw unauthorized();
  if (!token.scopes.includes('read')) {
    // PATs default to `['read']` — but a future operator could mint a write-
    // only PAT and try to use it here. Refuse with the same 401 the unknown-
    // token path emits (no information disclosure).
    throw unauthorized();
  }

  const user = await prisma.tenantUser.findUnique({ where: { id: token.tenantUserId } });
  if (!user) throw unauthorized();

  const membership = await prisma.tenantMembership.findUnique({
    where: {
      tenantUserId_tenantId: { tenantUserId: token.tenantUserId, tenantId: token.tenantId },
    },
  });
  if (!membership) throw unauthorized();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...publicUser } = user;
  request.tenantUser = publicUser;
  request.tenantId = token.tenantId;
  request.tenantRole = membership.role as TenantRole;
  request.tenantMembershipId = membership.id;
  request.operatorTokenScopes = token.scopes;

  // Best-effort lastUsedAt bump — never blocks the request.
  void prisma.tenantApiToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}

async function resolveByOAuthJwt(request: FastifyRequest, token: string): Promise<void> {
  const claims = verifyOperatorMcpAccessToken(token, operatorMcpIssuer());
  if (!claims) throw unauthorized();

  // Membership re-check on every request — the JWT's tid is a CLAIM the
  // operator picked at consent; that's the workspace for this request,
  // but we still confirm the membership is intact.
  const membership = await prisma.tenantMembership.findUnique({
    where: {
      tenantUserId_tenantId: { tenantUserId: claims.sub, tenantId: claims.tid },
    },
  });
  if (!membership) throw unauthorized();

  const user = await prisma.tenantUser.findUnique({ where: { id: claims.sub } });
  if (!user) throw unauthorized();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...publicUser } = user;
  request.tenantUser = publicUser;
  request.tenantId = claims.tid;
  request.tenantRole = membership.role as TenantRole;
  request.tenantMembershipId = membership.id;
  request.operatorMcpClaims = claims;
}
