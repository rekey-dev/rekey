/**
 * The one place an operator's application access is decided.
 *
 * ## Why this file exists
 *
 * The decision used to live in three copies: `ensureAppAccess` and
 * `appAccessScope` in `app-access.ts` for REST, and `accessibleApplicationIds`
 * in `tenant-mcp/operator-tools.ts` for MCP, with `loadAppInTenant` in
 * `operator-write-tools.ts` wrapping the third. The split existed because the
 * REST helper took a `FastifyRequest` and MCP handlers have no request. The
 * copies had already diverged: the MCP copy modelled `read` and only `read`,
 * and its caller warned that it would not protect a member write tool.
 *
 * The fix is not a fourth copy. It is one decision function that takes a plain
 * context, `{ tenantId, role, membershipId, scopes }`, and two thin adapters
 * that build that context from a request or from a tool context. The grants
 * query, the legacy-member rule, the OWNER/ADMIN short-circuit and the
 * denied-is-indistinguishable-from-absent 404 have exactly one home.
 *
 * ## Scopes
 *
 * A membership carries scopes (`lib/operator-scopes.ts`), the person's
 * ceiling, workspace-wide. The three grant roles are presets over the same
 * vocabulary. For an application request the effective set is the
 * INTERSECTION of the two, so neither can widen the other:
 *
 *     effective = presetScopes(grant.role) ∩ membership.scopes
 *
 * OWNER and ADMIN are unrestricted, as they always were: `ApplicationGrant`
 * cannot exist on their membership (`APP_GRANT_MEMBER_ONLY`), and they
 * short-circuit here before grants are read.
 *
 * The gate runs AFTER the existing checks, deliberately. A cross-tenant or
 * ungranted application still answers 404, denied stays indistinguishable
 * from absent, and only an application the caller can see can answer 403
 * for a missing scope. There is nothing to enumerate at that point: the
 * caller already knows the application exists.
 *
 * Which scope a route needs is read off the route's own declaration
 * (`config.access`, see `lib/route-access.ts`), not passed by the handler.
 * That is what lets 128 call sites keep their signature while every one of
 * them becomes scope-gated.
 */

import type { FastifyRequest } from 'fastify';
import type { ApplicationGrantRole, TenantRole } from '@prisma/client';
import {
  getCachedAppTenant,
  getCachedGrants,
  loadTicket,
  storeAppTenant,
  storeGrants,
  type GrantEntry,
} from './operator-auth-cache.js';
import { prisma } from './prisma.js';
import { RekeyError } from './error.js';
import {
  UNRESTRICTED,
  intersectScopes,
  presetScopes,
  type Scope,
  NO_SCOPES,
} from './operator-scopes.js';
import type { RouteAccess } from './route-access.js';

export type AppAccessNeed = 'read' | 'write' | 'billing-write';

export interface AppAccess {
  /**
   * How the access was satisfied:
   *  - 'workspace-admin', caller is OWNER/ADMIN (implicit full access)
   *  - 'legacy-member'  , grandfathered pre-grants membership (read-only)
   *  - ApplicationGrantRole  , MEMBER via an explicit grant on this Application
   */
  level: 'workspace-admin' | 'legacy-member' | ApplicationGrantRole;
  /** The caller's effective scopes on THIS application. What the panel renders from. */
  scopes: ReadonlySet<Scope>;
}

export interface AppAccessScope {
  /** false → caller sees every Application in the workspace (OWNER/ADMIN or grandfathered member). */
  restricted: boolean;
  /** Granted application ids (only meaningful when restricted). */
  applicationIds: string[];
  /** applicationId → granted role (only meaningful when restricted). */
  roleByApplicationId: Map<string, ApplicationGrantRole>;
}

/**
 * Everything the decision needs, and nothing tied to a transport.
 *
 * `membershipId` is null when the auth path could not resolve one. Every grant
 * check then fails CLOSED, a member whose grants cannot be read must not be
 * handed the workspace, except `applicationAccess`, which treats it as a
 * programming error (see `accessContextFromRequest`).
 *
 * `scopes` is the membership's ceiling, already intersected with any token's
 * scopes by the auth middleware. `UNRESTRICTED` for OWNER/ADMIN and for a
 * member nobody has restricted, which is every member today.
 */
export interface AccessContext {
  tenantId: string;
  role: TenantRole;
  membershipId: string | null;
  scopes: ReadonlySet<Scope>;
}

function internal(message: string, fix: string): RekeyError {
  return new RekeyError({ statusCode: 500, code: 'INTERNAL_ERROR', message, fix });
}

/**
 * Build the context from an operator request. Must run after one of the
 * operator auth middlewares (`requireTenantSession`, `resolveOperatorToken`,
 * the MCP bearer resolver), all three set `tenantId`, `tenantRole`,
 * `tenantMembershipId` and `tenantScopes`.
 *
 * Async only for the defensive fallback `ensureAppAccess` always had: an auth
 * path that set `tenantUser`/`tenantId` but not the membership id gets one
 * resolved here. No current path needs it; it is preserved, not relied on.
 *
 * `tenantScopes` absent fails closed (see `NO_SCOPES`): a MEMBER with no
 * scopes, the same default the operator MCP route applies. OWNER/ADMIN are
 * never gated on scopes, so the default only ever reaches a member.
 */
export async function accessContextFromRequest(req: FastifyRequest): Promise<AccessContext> {
  if (!req.tenantId || !req.tenantRole) {
    throw internal(
      'ensureAppAccess used without requireTenantSession.',
      'Register requireTenantSession before the route handler.',
    );
  }
  let membershipId: string | null = req.tenantMembershipId ?? null;
  if (membershipId === null && req.tenantUser) {
    const membership = await prisma.tenantMembership.findUnique({
      where: {
        tenantUserId_tenantId: { tenantUserId: req.tenantUser.id, tenantId: req.tenantId },
      },
      select: { id: true },
    });
    membershipId = membership?.id ?? null;
  }
  return {
    tenantId: req.tenantId,
    role: req.tenantRole,
    membershipId,
    scopes: req.tenantScopes ?? NO_SCOPES,
  };
}

/** Build the context from an MCP tool context. Synchronous; nothing to resolve. */
export function accessContextFromTool(ctx: {
  tenantId: string;
  role: TenantRole;
  tenantMembershipId?: string | undefined;
  scopes?: ReadonlySet<Scope> | undefined;
}): AccessContext {
  return {
    tenantId: ctx.tenantId,
    role: ctx.role,
    membershipId: ctx.tenantMembershipId ?? null,
    // Fail closed, like the request path above. The route always sets scopes;
    // a caller that forgets must not inherit every one.
    scopes: ctx.scopes ?? NO_SCOPES,
  };
}

export interface GrantSet {
  /** applicationId → granted role. */
  byApplication: Map<string, ApplicationGrantRole>;
  /**
   * Grandfathered pre-grants membership: workspace-wide READ, no writes.
   * Set ONLY by the 2.0.0-rc.3 backfill. Only meaningful when
   * `byApplication` is empty, setting a grant clears the flag, and the
   * migration cleared it for any row that already had one, so "grandfathered
   * AND granted" is unreachable. If it ever did occur, grants win, exactly as
   * they always have.
   */
  legacyWorkspaceRead: boolean;
}

/**
 * The one grants query. Every decision below reads through this.
 *
 * A context with no membership id resolves to an empty set with the legacy
 * flag off, the closed default, rather than throwing, so a caller that
 * wants to fail closed can, and a caller that wants to treat it as a
 * programming error checks before calling.
 */
export async function resolveGrantSet(ctx: AccessContext): Promise<GrantSet> {
  if (ctx.membershipId === null) {
    return { byApplication: new Map(), legacyWorkspaceRead: false };
  }
  // Cached per membership (lib/operator-auth-cache.ts). Every grant write and
  // every role, scope or removal write on the membership invalidates it.
  const cached = getCachedGrants(ctx.membershipId);
  if (cached) return toGrantSet(cached);
  const ticket = loadTicket();
  const [grants, membership] = await Promise.all([
    prisma.applicationGrant.findMany({
      where: { tenantMembershipId: ctx.membershipId },
      select: { applicationId: true, role: true },
    }),
    prisma.tenantMembership.findUnique({
      where: { id: ctx.membershipId },
      select: { legacyWorkspaceRead: true },
    }),
  ]);
  const entry = { grants, legacyWorkspaceRead: membership?.legacyWorkspaceRead === true };
  // A membership that no longer exists is not cached: nothing to invalidate
  // it by, and the next read should see whatever replaced it.
  if (membership) storeGrants(ticket, ctx.membershipId, entry);
  return toGrantSet(entry);
}

function toGrantSet(entry: GrantEntry): GrantSet {
  return {
    byApplication: new Map(entry.grants.map((g) => [g.applicationId, g.role])),
    // `grants.length === 0` as well as the flag, deliberately, see GrantSet.
    legacyWorkspaceRead: entry.grants.length === 0 && entry.legacyWorkspaceRead,
  };
}

/**
 * The workspace an application belongs to, or null when it does not exist.
 * The mapping never changes once created, so a found one is cached for the
 * life of the process (lib/operator-auth-cache.ts).
 */
async function applicationTenantId(applicationId: string): Promise<string | null> {
  const cached = getCachedAppTenant(applicationId);
  if (cached !== null) return cached;
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { tenantId: true },
  });
  if (!app) return null;
  storeAppTenant(applicationId, app.tenantId);
  return app.tenantId;
}

export function isWorkspaceAdmin(role: TenantRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

function notFound(applicationId: string): RekeyError {
  // Don't disclose existence (in another tenant, or behind a missing grant),
  // return the same code as "not found" to avoid being an enumeration oracle.
  return new RekeyError({
    statusCode: 404,
    code: 'APPLICATION_NOT_FOUND',
    message: `Application "${applicationId}" not found in this workspace.`,
    fix: 'List applications via GET /api/v1/tenant/applications.',
  });
}

function legacyWriteDenied(role: string): RekeyError {
  // Same code/shape requireTenantRole(['OWNER','ADMIN']) used to emit for a
  // MEMBER hitting these routes, kept for client back-compat.
  return new RekeyError({
    statusCode: 403,
    code: 'TENANT_ROLE_INSUFFICIENT',
    message: `This action requires one of: OWNER, ADMIN. Your role: ${role}.`,
    fix: 'Ask a workspace owner or admin to perform this action, to upgrade your role, or to grant you an application role (APP_ADMIN / APP_BILLING).',
  });
}

function grantDenied(need: AppAccessNeed, granted: ApplicationGrantRole): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'APP_ACCESS_DENIED',
    message: `Your application role ${granted} does not allow this action (requires ${
      need === 'billing-write' ? 'APP_BILLING or APP_ADMIN' : 'APP_ADMIN'
    }).`,
    fix: 'Ask a workspace owner or admin to raise your application grant via PUT /api/v1/tenant/workspace/members/:membershipId/grants.',
  });
}

export function scopeDenied(scope: Scope): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'SCOPE_INSUFFICIENT',
    message: `This action requires the '${scope}' scope, which your membership does not hold.`,
    fix: 'Ask a workspace owner or admin to extend your scopes via PATCH /api/v1/tenant/workspace/members/:membershipId.',
  });
}

/**
 * The caller's effective scopes on an application, given how access was
 * satisfied. Workspace admins are unrestricted; a legacy member reads
 * everything (the APP_VIEWER preset); a grant holder gets the preset for
 * their role, each intersected with the membership's own ceiling.
 */
export function effectiveApplicationScopes(
  ctx: AccessContext,
  level: AppAccess['level'],
): ReadonlySet<Scope> {
  if (level === 'workspace-admin') return UNRESTRICTED;
  const preset = level === 'legacy-member' ? presetScopes('APP_VIEWER') : presetScopes(level);
  return intersectScopes(preset, ctx.scopes);
}

/**
 * May this caller perform `need` on this Application? Answers BOTH questions
 * the old helper did: does the Application belong to the workspace (404
 * otherwise, same non-disclosure posture), and is the caller allowed `need`
 * on it, and then, if the route declared a scope, whether the caller's
 * effective scopes on this application include it.
 *
 *   OWNER / ADMIN   → implicit full access.
 *   MEMBER          → grants are authoritative, INCLUDING when there are none.
 *                     No grant → 404 (denied is indistinguishable from absent).
 *                     APP_VIEWER read · APP_BILLING read + billing-write ·
 *                     APP_ADMIN everything. Insufficient → 403 APP_ACCESS_DENIED.
 *                     Then: declared scope ∉ effective → 403 SCOPE_INSUFFICIENT.
 *   legacy member   → read only, writes 403 TENANT_ROLE_INSUFFICIENT.
 */
export async function applicationAccess(
  ctx: AccessContext,
  applicationId: string,
  need: AppAccessNeed,
  declared?: RouteAccess | undefined,
): Promise<AppAccess> {
  const tenantId = await applicationTenantId(applicationId);
  if (tenantId === null || tenantId !== ctx.tenantId) throw notFound(applicationId);

  if (isWorkspaceAdmin(ctx.role)) return { level: 'workspace-admin', scopes: UNRESTRICTED };

  if (ctx.membershipId === null) {
    throw internal(
      'ensureAppAccess used without requireTenantSession.',
      'Register requireTenantSession before the route handler.',
    );
  }
  const grants = await resolveGrantSet(ctx);
  const role = grants.byApplication.get(applicationId);

  let level: AppAccess['level'];
  if (role === undefined) {
    if (!grants.legacyWorkspaceRead) {
      // Default since 2.0.0-rc.3: closed. Same 404 an ungranted Application
      // already returned for a member who held grants elsewhere.
      throw notFound(applicationId);
    }
    if (need !== 'read') throw legacyWriteDenied(ctx.role);
    level = 'legacy-member';
  } else {
    if (need === 'billing-write' && role !== 'APP_ADMIN' && role !== 'APP_BILLING') {
      throw grantDenied(need, role);
    }
    if (need === 'write' && role !== 'APP_ADMIN') throw grantDenied(need, role);
    level = role;
  }

  const scopes = effectiveApplicationScopes(ctx, level);
  // The scope gate, last. Only `{ scope }` declarations gate; `open`, `floor`
  // and `project` routes pass here and shape or floor themselves.
  if (declared !== undefined && 'scope' in declared && !scopes.has(declared.scope)) {
    throw scopeDenied(declared.scope);
  }
  return { level, scopes };
}

/**
 * Which Applications may the caller see at all? Feeds the list endpoint, the
 * panel sidebar and the command palette.
 */
export async function accessScope(ctx: AccessContext): Promise<AppAccessScope> {
  if (isWorkspaceAdmin(ctx.role) || ctx.membershipId === null) {
    return { restricted: false, applicationIds: [], roleByApplicationId: new Map() };
  }
  const grants = await resolveGrantSet(ctx);
  // Grandfathered pre-grants membership, workspace-wide read. Zero grants on
  // its own no longer widens the scope: since 2.0.0-rc.3 it narrows it to
  // nothing, which is what a new MEMBER invitation is supposed to produce.
  if (grants.legacyWorkspaceRead) {
    return { restricted: false, applicationIds: [], roleByApplicationId: new Map() };
  }
  return {
    restricted: true,
    applicationIds: [...grants.byApplication.keys()],
    roleByApplicationId: grants.byApplication,
  };
}

/**
 * The Applications this caller may READ, as ids, what the MCP handlers
 * resolve their Application set through.
 *
 * Returns `[]` for a caller with grants that name no Application, which every
 * handler treats as "nothing to show", the same empty result an operator with
 * no Applications gets, so a denied Application is indistinguishable from an
 * absent one. A context with no membership id also returns `[]`: fail CLOSED.
 */
export async function accessibleApplicationIds(ctx: AccessContext): Promise<string[]> {
  const all = await prisma.application.findMany({
    where: { tenantId: ctx.tenantId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const allIds = all.map((a) => a.id);
  if (isWorkspaceAdmin(ctx.role)) return allIds;
  if (ctx.membershipId === null) return [];
  const grants = await resolveGrantSet(ctx);
  if (grants.legacyWorkspaceRead) return allIds;
  return allIds.filter((id) => grants.byApplication.has(id));
}
