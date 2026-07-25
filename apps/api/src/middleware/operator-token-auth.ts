/**
 * Operator personal-access-token (PAT) auth guard.
 *
 * For tenant-scoped routes that an operator (or an AI agent acting as them)
 * may call with a long-lived `Authorization: Bearer rp_op_…` token instead of
 * a short-lived session JWT — replacing reliance on the global SUPER_ADMIN_KEY.
 *
 * On success it decorates the request EXACTLY like `requireTenantSession`:
 *   - request.tenantUser  — the operator (PublicTenantUser)
 *   - request.tenantId    — the workspace the PAT is bound to
 *   - request.tenantRole  — the operator's LIVE role in that workspace (from DB)
 *   - request.operatorTokenScopes — the PAT's granted scopes
 *
 * so downstream tenant handlers (which read req.tenantId / req.tenantUser /
 * req.tenantRole) work unchanged.
 *
 * Security:
 *   - Hash-only lookup. The presented raw token is SHA-256'd (lib/keys.hashKey)
 *     and looked up against the unique `token_hash` index — a direct, scan-free
 *     lookup with no timing oracle. Unknown / revoked / expired ⇒ 401.
 *   - Membership is re-confirmed against the DB on every request. A PAT minted
 *     while the operator was a member doesn't keep working after the operator
 *     is removed from (or loses their role in) that workspace.
 *   - Scopes are default-deny: a route that needs to write must guard itself
 *     with `requireOperatorScope(...)`. A PAT with no write scope can read but
 *     not mutate.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TenantRole } from '@prisma/client';
import { RelipayError } from '../lib/error.js';
import { prisma } from '../lib/prisma.js';
import { hashOperatorToken, type OperatorTokenScope } from '../lib/operator-token.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Scopes granted to the operator PAT used for this request (if any). */
    operatorTokenScopes?: string[];
  }
}

/** Shared 401 for every "this PAT can't authenticate" case. Deliberately uniform
 * so unknown / revoked / expired tokens are indistinguishable to a caller. */
function unauthorized(): RelipayError {
  return new RelipayError({
    statusCode: 401,
    code: 'OPERATOR_TOKEN_INVALID',
    message: 'Operator personal-access-token is missing, invalid, revoked, or expired.',
    fix: 'Mint a fresh token via POST /api/v1/tenant/auth/api-tokens (operator session required) and send it as Authorization: Bearer rp_op_…',
  });
}

/**
 * `onRequest` guard: authenticate the request via an operator PAT. Throws 401
 * on any failure. On success, decorates the request like `requireTenantSession`
 * and records `lastUsedAt` best-effort (fire-and-forget — never blocks or fails
 * the request).
 */
export async function resolveOperatorToken(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) throw unauthorized();

  // Direct hash lookup against the unique index — no scan, no timing oracle.
  // A wrong token simply doesn't match any row.
  const token = await prisma.tenantApiToken.findUnique({
    where: { tokenHash: hashOperatorToken(presented) },
  });
  if (!token) throw unauthorized();
  if (token.revokedAt !== null) throw unauthorized();
  if (token.expiresAt !== null && token.expiresAt <= new Date()) throw unauthorized();

  const user = await prisma.tenantUser.findUnique({ where: { id: token.tenantUserId } });
  if (!user) throw unauthorized();

  // Re-confirm membership against the DB. A PAT is bound to one workspace; if
  // the operator was removed from it (or had their role changed) after the PAT
  // was minted, the live membership decides — exactly like requireTenantSession.
  const membership = await prisma.tenantMembership.findUnique({
    where: {
      tenantUserId_tenantId: { tenantUserId: token.tenantUserId, tenantId: token.tenantId },
    },
  });
  if (!membership) {
    throw new RelipayError({
      statusCode: 403,
      code: 'TENANT_MEMBERSHIP_REVOKED',
      message: 'The operator behind this token is no longer a member of its workspace.',
      fix: 'Re-add the operator to the workspace, or mint a fresh token from a workspace they belong to.',
    });
  }

  // Strip passwordHash before attaching (mirrors requireTenantSession).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...publicUser } = user;
  request.tenantUser = publicUser;
  request.tenantId = token.tenantId;
  // Use the LIVE role from the DB, not whatever was true at mint time.
  request.tenantRole = membership.role as TenantRole;
  request.tenantMembershipId = membership.id;
  request.operatorTokenScopes = token.scopes;

  // Best-effort lastUsedAt bump. Fire-and-forget: a failed write here must
  // never reject the request. Not awaited.
  void prisma.tenantApiToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      /* ignore — telemetry only */
    });
}

/**
 * Higher-order guard enforcing that the authenticating PAT carries `scope`.
 * Default-deny: use as a per-route `preHandler` AFTER `resolveOperatorToken`.
 * 403s with `OPERATOR_SCOPE_INSUFFICIENT` when the scope is absent.
 *
 * @example
 * ```ts
 * app.post('/thing', {
 *   onRequest: resolveOperatorToken,
 *   preHandler: requireOperatorScope('keys:mint'),
 * }, handler);
 * ```
 */
export function requireOperatorScope(
  scope: OperatorTokenScope,
): (req: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  return async (req) => {
    if (!req.operatorTokenScopes) {
      throw new RelipayError({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'requireOperatorScope used without resolveOperatorToken.',
        fix: 'Register resolveOperatorToken as onRequest before requireOperatorScope on the route.',
      });
    }
    if (!req.operatorTokenScopes.includes(scope)) {
      throw new RelipayError({
        statusCode: 403,
        code: 'OPERATOR_SCOPE_INSUFFICIENT',
        message: `This action requires the '${scope}' scope. Your token's scopes: ${req.operatorTokenScopes.join(', ') || '(none)'}.`,
        fix: `Mint a new personal-access-token that includes the '${scope}' scope, then retry with it.`,
      });
    }
  };
}
