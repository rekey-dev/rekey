/**
 * What every operator route declares about itself, and the table built from it.
 *
 * ## The rule
 *
 * Every route under an operator prefix carries `config.access`, one of:
 *
 *   { scope: 'billing:read' }   gated by one scope (plus whatever role floor
 *                               the route's own preHandler already imposes,
 *                               the two compose as AND, floor first)
 *   { floor: true }             role-gated only. No scope unlocks it, ever.
 *                               Lifecycle, impersonation, DSAR, erase, team.
 *   { open: true }              session-only. No application, or the handler
 *                               scopes its own result (the list endpoint).
 *   { project: '<name>' }       a mixed response, shaped per caller by a named
 *                               projection rather than allowed or denied.
 *
 * ## Why declared on the route and not in a separate table
 *
 * A table in its own file is a second thing that has to be kept true. The
 * route already says what it is, its path, its preHandler, its schema, and
 * the classification belongs beside those, where the person editing the route
 * will see it. `collectRouteAccess` then builds the table FROM the
 * declarations at registration time, so there is exactly one source and the
 * test in `test/route-access-completeness.test.ts` can fail the moment a
 * route ships without one. Method inference is not an option:
 * `POST …/email-templates/:eventKey/preview` is a read.
 *
 * Nothing here enforces anything yet. This is the classification (WS2). The
 * gate that reads it is WS3, and it will read exactly these declarations.
 */

import type { FastifyInstance, HTTPMethods } from 'fastify';
import { isScope, type Scope } from './operator-scopes.js';

export type RouteAccess =
  | { scope: Scope }
  | { floor: true }
  | { open: true }
  | { project: 'application' | 'workspace-members' };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

export interface RouteAccessEntry {
  method: HTTPMethods | HTTPMethods[];
  url: string;
  access: RouteAccess | undefined;
}

/**
 * Prefixes whose routes MUST declare `config.access`. Everything an operator
 * session or PAT can reach and that touches workspace or application data.
 *
 * Not listed, deliberately: `/api/v1/tenant/auth`, `/mfa`, `/operator`, `/mcp`
 * and `/invitations`, operator-self, token-gated, or public surfaces that
 * carry no application data and are gated by their own means. They are the
 * `operator-self` group in the spec's route survey.
 */
export const ACCESS_DECLARED_PREFIXES = [
  '/api/v1/tenant/applications',
  '/api/v1/tenant/workspace',
  '/api/v1/tenant/security-events',
] as const;

/**
 * Register on the app BEFORE any route plugin. Collects every registered
 * route's declaration into `app.routeAccess`, which the completeness test
 * reads and which a capabilities endpoint can later render from.
 */
export function collectRouteAccess(app: FastifyInstance): void {
  const table: RouteAccessEntry[] = [];
  app.decorate('routeAccess', table);
  app.addHook('onRoute', (route) => {
    table.push({ method: route.method, url: route.url, access: route.config?.access });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    routeAccess: RouteAccessEntry[];
  }
}

/** True if this URL is one the rule applies to. */
export function accessDeclarationRequired(url: string): boolean {
  return ACCESS_DECLARED_PREFIXES.some((p) => url === p || url.startsWith(p + '/'));
}

/** A declaration is well-formed: known shape, and any scope is one the registry knows. */
export function routeAccessIsValid(access: RouteAccess): boolean {
  if ('scope' in access) return isScope(access.scope);
  if ('floor' in access) return access.floor === true;
  if ('open' in access) return access.open === true;
  if ('project' in access) return access.project === 'application' || access.project === 'workspace-members';
  return false;
}
