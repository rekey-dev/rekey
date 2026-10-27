/**
 * Operator auth for tenant routes an operator may drive from a script: an
 * operator personal access token (`Bearer rp_op_…`) or a panel session.
 *
 * Both paths set the same request fields (tenantId, tenantUser, live
 * tenantRole, tenantMembershipId, tenantScopes), so every `config.access`
 * scope check, `ensureAppAccess` call and `requireTenantRole` floor behind
 * this guard applies unchanged. A PAT's scopes are already intersected with
 * the membership's, so a token never reaches more than its holder could.
 *
 * Security: `ensureAppAccess` admits OWNER and ADMIN on any scope, so for
 * them the token's own scopes would never be read there. The guard checks
 * them itself: a PAT must hold the route's declared scope, and a route that
 * declares none must be a read unless the PAT carries `applications:write`.
 * Without this, a `read` PAT minted by an owner could write.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { RekeyError } from '../lib/error.js';
import { isOperatorToken } from '../lib/operator-token.js';
import { patTokenScopes } from '../lib/operator-scopes.js';
import { resolveOperatorToken } from './operator-token-auth.js';
import { requireTenantSession } from './tenant-session.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `true` admits an operator personal access token on this route, in a
     * plugin whose hook is `requireSessionOrOptedInToken`; every other route
     * there stays session-only. `false` makes a route session-only in a
     * plugin whose hook is `requireOperatorAuth`.
     */
    operatorToken?: boolean;
  }
}

/**
 * `onRequest` guard accepting an operator PAT or an operator session.
 *
 * @example
 * ```ts
 * app.addHook('onRequest', requireOperatorAuth);
 * ```
 */
export async function requireOperatorAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!bearsOperatorToken(request)) return requireTenantSession(request, reply);
  // Refused before the scope check, so a token is never told to fetch a scope that would not help.
  if (request.routeOptions.config.operatorToken === false) throw tokenNotAccepted();
  await resolveOperatorToken(request, reply);
  assertTokenCoversRoute(request, request.operatorTokenScopes ?? []);
}

/**
 * `onRequest` guard for a plugin where most routes are session-only: a route
 * that sets `config.operatorToken` gets {@link requireOperatorAuth}, every
 * other route `requireTenantSession`, and a token there is refused with
 * `OPERATOR_TOKEN_NOT_ACCEPTED` rather than read as a broken session.
 *
 * @example
 * ```ts
 * app.addHook('onRequest', requireSessionOrOptedInToken);
 * app.get('/:id/plans', { config: { access: { scope: 'billing:read' }, operatorToken: true } }, handler);
 * ```
 */
export async function requireSessionOrOptedInToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.routeOptions.config.operatorToken === true) return requireOperatorAuth(request, reply);
  if (bearsOperatorToken(request)) throw tokenNotAccepted();
  return requireTenantSession(request, reply);
}

function bearsOperatorToken(request: FastifyRequest): boolean {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') && isOperatorToken(header.slice(7));
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function assertTokenCoversRoute(request: FastifyRequest, tokenScopes: readonly string[]): void {
  const access = request.routeOptions.config.access;
  const needed =
    access !== undefined && 'scope' in access
      ? access.scope
      : READ_METHODS.has(request.method)
        ? null
        : 'applications:write';
  if (needed === null) return;
  const held = needed === 'applications:write' ? tokenScopes.includes(needed) : patTokenScopes(tokenScopes).has(needed);
  if (held) return;
  throw new RekeyError({
    statusCode: 403,
    code: 'OPERATOR_SCOPE_INSUFFICIENT',
    message: `This action needs '${needed}', which this personal access token does not grant. Its scopes: ${tokenScopes.join(', ') || '(none)'}.`,
    fix: "Mint a personal access token with the 'applications:write' scope (writes) or 'read' (reads) via POST /api/v1/tenant/auth/api-tokens, then retry with it.",
  });
}

function tokenNotAccepted(): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'OPERATOR_TOKEN_NOT_ACCEPTED',
    message: 'This action needs an operator session; a personal access token cannot perform it.',
    fix: 'Do this from the Rekey panel, or call the route with a session access token from POST /api/v1/tenant/auth/sign-in.',
  });
}
