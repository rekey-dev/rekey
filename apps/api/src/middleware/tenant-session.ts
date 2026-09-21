/**
 * Operator session middleware.
 *
 * For routes under /api/v1/tenant/*. Verifies the access JWT in the
 * Authorization header (we don't use cookies for the API itself, the
 * panel handles its own cookie session and forwards the bearer here).
 *
 * On success, attaches:
 *   - request.tenantUser , the operator (PublicTenantUser)
 *   - request.tenantId   , the active workspace id (from the JWT's `tid`)
 *   - request.tenantRole , the LIVE role within that workspace
 *
 * `tenantRole` is the LIVE membership role; the token's `rol` claim is
 * ignored. A role downgrade or removal therefore takes effect on the next
 * request (removal → 403 `TENANT_MEMBERSHIP_REVOKED`) instead of waiting out
 * the access token.
 *
 * The operator row, session liveness and membership are read through
 * `lib/operator-auth-cache.ts`: a hit costs no query, a miss costs the same
 * lookups as before. Every revoke, role, scope and grant write invalidates it
 * in this process at once and in every other over Redis pub/sub; only an
 * admitted request is ever cached. The file header there says what bounds
 * the staleness that remains.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TenantRole } from '@prisma/client';
import { RekeyError } from '../lib/error.js';
import { verifyTenantAccessToken, type TenantSessionClaims } from '../lib/tenant-jwt.js';
import { prisma } from '../lib/prisma.js';
import type { PublicTenantUser } from '../modules/tenant-auth/tenant-auth.service.js';
import { sessionEnded, sessionIssuedBefore } from '../lib/session-stamp.js';
import { resolveMembershipScopes, type Scope } from '../lib/operator-scopes.js';
import {
  getCachedAuth,
  loadTicket,
  storeAuth,
  type AuthEntry,
} from '../lib/operator-auth-cache.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantUser?: PublicTenantUser;
    tenantId?: string;
    tenantRole?: TenantRole;
    /** Membership row id for (tenantUser, tenant), used by per-app grant checks. */
    tenantMembershipId?: string;
    /**
     * The caller's effective scopes: the membership's ceiling, already
     * intersected with the token's scopes on the PAT and MCP paths. Read by
     * `ensureAppAccess` via the access context. UNRESTRICTED for OWNER/ADMIN
     * and for every member nobody has restricted.
     */
    tenantScopes?: ReadonlySet<Scope>;
    /**
     * What the access decision on this request resolved to, for the request
     * log. `scope` is the declaration that admitted it (null for open,
     * floor and project routes); `level` is how access was satisfied.
     */
    accessDecision?: { scope: Scope | null; level: string };
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

  const cached = getCachedAuth(claims.sub, claims.tid, claims.sid);
  const resolved = cached ?? (await loadAuth(claims));

  // The stamp is compared per token (each carries its own `iat`), so it is
  // checked on a hit as well: a cached row still refuses a token minted
  // before the stamp it holds.
  if (sessionIssuedBefore(claims, resolved.user.sessionsInvalidBefore)) {
    throw sessionEndedEverywhere();
  }

  const { membership, user } = resolved;
  request.tenantUser = user;
  request.tenantId = claims.tid;
  // Use the LIVE role from DB, not the token, mirrors role downgrades.
  request.tenantRole = membership.role;
  request.tenantMembershipId = membership.id;
  request.tenantScopes = resolveMembershipScopes(membership.scopesRestricted, membership.scopes);
}

function sessionEndedEverywhere(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'TENANT_SESSION_INVALID',
    message: 'Operator session was ended (password changed or signed out everywhere).',
    fix: 'Sign in again.',
  });
}

/**
 * The uncached path: read the rows, refuse exactly as before, and store the
 * result only when the request is admitted.
 */
async function loadAuth(claims: TenantSessionClaims): Promise<AuthEntry> {
  // Taken before the first read. An invalidation that lands while these
  // queries are in flight makes `storeAuth` discard the result.
  const ticket = loadTicket();

  // The session head is read beside the user row, in parallel, and only for
  // tokens that carry `sid`: one lookup on the unique live-head index. Only a
  // live head is read (a revoked one ends the session just as a missing one
  // does), because that filter is the index predicate.
  const [user, head] = await Promise.all([
    prisma.tenantUser.findUnique({ where: { id: claims.sub } }),
    claims.sid
      ? prisma.tenantRefreshToken.findFirst({
          where: { sessionId: claims.sid, tenantUserId: claims.sub, replacedById: null, revokedAt: null },
          select: { revokedAt: true },
        })
      : null,
  ]);
  if (!user) {
    throw new RekeyError({
      statusCode: 401,
      code: 'TENANT_SESSION_INVALID',
      message: 'Operator account no longer exists.',
      fix: 'Sign in again to obtain a valid session.',
    });
  }
  // Minted before the operator's last password change or sign-out
  // everywhere: refused now, whatever the configured access lifetime.
  if (sessionIssuedBefore(claims, user.sessionsInvalidBefore)) {
    throw sessionEndedEverywhere();
  }
  // Only this session was revoked (DELETE /tenant/auth/sessions/:id). The
  // operator's other sessions keep their access tokens: no per-operator stamp.
  if (sessionEnded(claims, head, null)) {
    throw new RekeyError({
      statusCode: 401,
      code: 'TENANT_SESSION_INVALID',
      message: 'This operator session was revoked.',
      fix: 'Sign in again.',
    });
  }

  // Re-confirm membership against the DB. If the user was removed from this
  // workspace after the token was issued, their JWT shouldn't be enough to
  // keep operating in it.
  const membership = await prisma.tenantMembership.findUnique({
    where: {
      tenantUserId_tenantId: { tenantUserId: claims.sub, tenantId: claims.tid },
    },
    select: { id: true, role: true, scopesRestricted: true, scopes: true },
  });
  if (!membership) {
    throw new RekeyError({
      statusCode: 403,
      code: 'TENANT_MEMBERSHIP_REVOKED',
      message: 'You are no longer a member of this workspace.',
      fix: 'Switch workspace via /api/v1/tenant/auth/switch-workspace, or ask the owner for a fresh invitation.',
    });
  }

  // Strip passwordHash before attaching, and before caching. Frozen because
  // the cached objects are shared by every request this entry admits.
  const { passwordHash, ...publicUser } = user;
  const entry: AuthEntry = {
    user: Object.freeze(publicUser),
    membership: Object.freeze({ ...membership, scopes: Object.freeze([...membership.scopes]) as string[] }),
  };
  storeAuth(ticket, claims.sub, claims.tid, claims.sid, entry);
  return entry;
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
