/**
 * Operator session middleware.
 *
 * For routes under /api/v1/tenant/*. Verifies the access JWT in the
 * Authorization header (we don't use cookies for the API itself — the
 * panel handles its own cookie session and forwards the bearer here).
 *
 * On success, attaches:
 *   - request.tenantUser  — the operator (PublicTenantUser)
 *   - request.tenantId    — the active workspace id (from the JWT's `tid`)
 *   - request.tenantRole  — the LIVE role within that workspace
 *
 * `tenantRole` is re-read from `tenant_memberships` on every request; the
 * token's `rol` claim is ignored. A role downgrade or removal therefore takes
 * effect immediately (removal → 403 `TENANT_MEMBERSHIP_REVOKED`) instead of
 * waiting out the 15-minute access token. That costs one indexed lookup per
 * request, which is cheaper than every role-gated service having to remember to
 * re-check for itself.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TenantRole } from '@prisma/client';
import { RekeyError } from '../lib/error.js';
import { verifyTenantAccessToken } from '../lib/tenant-jwt.js';
import { prisma } from '../lib/prisma.js';
import type { PublicTenantUser } from '../modules/tenant-auth/tenant-auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantUser?: PublicTenantUser;
    tenantId?: string;
    tenantRole?: TenantRole;
    /** Membership row id for (tenantUser, tenant) — used by per-app grant checks. */
    tenantMembershipId?: string;
  }
}

export async function requireTenantSession(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented) {
    throw new RekeyError({
      statusCode: 401,
      code: 'TENANT_SESSION_MISSING',
      message: 'This endpoint requires an Authorization: Bearer <accessToken> header.',
      fix: 'Sign in to the Rekey panel (or POST to /api/v1/tenant/auth/sign-in) and pass the returned accessToken.',
    });
  }
  const claims = verifyTenantAccessToken(presented);
  if (!claims) {
    throw new RekeyError({
      statusCode: 401,
      code: 'TENANT_SESSION_INVALID',
      message: 'Operator session token is invalid, expired, or signed with a different secret.',
      fix: 'Refresh the token via /api/v1/tenant/auth/refresh, or sign in again.',
    });
  }

  const user = await prisma.tenantUser.findUnique({ where: { id: claims.sub } });
  if (!user) {
    throw new RekeyError({
      statusCode: 401,
      code: 'TENANT_SESSION_INVALID',
      message: 'Operator account no longer exists.',
      fix: 'Sign in again to obtain a valid session.',
    });
  }

  // Re-confirm membership against the DB. If the user was removed from this
  // workspace after the token was issued, their JWT shouldn't be enough to
  // keep operating in it.
  const membership = await prisma.tenantMembership.findUnique({
    where: {
      tenantUserId_tenantId: { tenantUserId: claims.sub, tenantId: claims.tid },
    },
  });
  if (!membership) {
    throw new RekeyError({
      statusCode: 403,
      code: 'TENANT_MEMBERSHIP_REVOKED',
      message: 'You are no longer a member of this workspace.',
      fix: 'Switch workspace via /api/v1/tenant/auth/switch-workspace, or ask the owner for a fresh invitation.',
    });
  }

  // Strip passwordHash before attaching.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...publicUser } = user;
  request.tenantUser = publicUser;
  request.tenantId = claims.tid;
  // Use the LIVE role from DB, not the token — mirrors role downgrades.
  request.tenantRole = membership.role;
  request.tenantMembershipId = membership.id;
}

/**
 * Higher-order guard for role-restricted routes. Use as a per-route
 * `preHandler` after `requireTenantSession`.
 *
 * @example
 * ```ts
 * app.post('/some-thing', {
 *   onRequest: requireTenantSession,
 *   preHandler: requireTenantRole(['OWNER', 'ADMIN']),
 * }, handler);
 * ```
 */
export function requireTenantRole(
  allowed: ReadonlyArray<TenantRole>,
): (req: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  return async (req) => {
    if (!req.tenantRole) {
      throw new RekeyError({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'requireTenantRole used without requireTenantSession.',
        fix: 'Register requireTenantSession before requireTenantRole on the route.',
      });
    }
    if (!allowed.includes(req.tenantRole)) {
      throw new RekeyError({
        statusCode: 403,
        code: 'TENANT_ROLE_INSUFFICIENT',
        message: `This action requires one of: ${allowed.join(', ')}. Your role: ${req.tenantRole}.`,
        fix: 'Ask a workspace owner or admin to perform this action, or to upgrade your role.',
      });
    }
  };
}
