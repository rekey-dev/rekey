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

/**
 * `onRequest` guard accepting an operator PAT or an operator session.
 *
 * @example
 * ```ts
 * app.addHook('onRequest', requireOperatorAuth);
 * ```
 */
export async function requireOperatorAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || !isOperatorToken(header.slice(7))) {
    return requireTenantSession(request, reply);
  }
  await resolveOperatorToken(request, reply);
  assertTokenCoversRoute(request, request.operatorTokenScopes ?? []);
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

/**
 * `preHandler` for a route behind `requireOperatorAuth` that must stay
 * session-only, such as a bulk personal-data export that should leave an
 * audit trail tied to someone at the panel, not a long-lived token.
 */
export async function refuseOperatorToken(request: FastifyRequest): Promise<void> {
  if (request.operatorTokenScopes !== undefined) {
    throw new RekeyError({
      statusCode: 403,
      code: 'OPERATOR_TOKEN_NOT_ACCEPTED',
      message: 'This action needs an operator session; a personal access token cannot perform it.',
      fix: 'Do this from the Rekey panel, or call the route with a session access token from POST /api/v1/tenant/auth/sign-in.',
    });
  }
}
