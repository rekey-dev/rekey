/**
 * Per-application access control for operator (tenant-session) routes.
 *
 * Replaces the old per-file `ensureAppInTenant` helper on every
 * /api/v1/tenant/applications/:id/* route. One call answers BOTH questions:
 *   1. Does this Application belong to the active workspace? (404 otherwise —
 *      same non-disclosure posture as before)
 *   2. Is the calling operator allowed to do `need` on it?
 *
 * Permission model (roadmap #8, v1 — see prisma `ApplicationGrant`):
 *
 *   Workspace role  | Effect
 *   ----------------|---------------------------------------------------------
 *   OWNER / ADMIN   | Implicit full access to every Application (unchanged).
 *   MEMBER          | Grants are authoritative, INCLUDING when there are none.
 *                   | No grant on an Application → 404 APPLICATION_NOT_FOUND
 *                   | (even for reads). With a grant:
 *                   |   APP_VIEWER  → read only
 *                   |   APP_BILLING → read + billing-write (plans, coupons,
 *                   |                 entitlements, credit grants)
 *                   |   APP_ADMIN   → read + billing-write + write
 *                   | Insufficient grant role → 403 APP_ACCESS_DENIED.
 *   MEMBER, with    | LEGACY mode: read-only on every Application, writes 403
 *   legacyWorkspace | TENANT_ROLE_INSUFFICIENT. Set ONLY by the 2.0.0-rc.3
 *   Read = true     | backfill, for memberships that existed before grant-
 *                   | scoped access became the default. Cleared for good the
 *                   | moment any grant is set on the membership.
 *
 * CHANGED IN 2.0.0-rc.3 (behaviour change, see CHANGELOG). "MEMBER with zero
 * grants" used to mean "read every Application in the workspace", on the
 * grounds that members who predated grants must not lose access. But zero
 * grants is also what a freshly accepted MEMBER invitation produces, so the
 * migration accommodation was in fact the live default: inviting a contractor
 * as MEMBER handed them every Application's end-user roster (with emails),
 * API-key metadata, billing-credential status, payments, webhooks, coupons,
 * licences, organizations and email logs — 31 read endpoints on an Application
 * nobody had granted them. The accommodation is now an explicit per-membership
 * flag (`TenantMembership.legacyWorkspaceRead`) that only the backfill sets,
 * and the DEFAULT for every new membership is closed.
 *
 * Route classification ("need"):
 *   'read'          — GET surfaces (lists, stats, configs, logs).
 *   'billing-write' — mutations on the billing catalog: plans, plan
 *                     entitlements, coupons, manual credit grants.
 *   'write'         — every other mutation: auth config, API keys, billing
 *                     credentials/config, OAuth config, end-users, licenses,
 *                     usage meters, organizations, webhooks, email, access
 *                     controls, session rotation.
 *
 * Routes that stay OWNER/ADMIN-only regardless of grants (extra-sensitive,
 * gated by `requireTenantRole(['OWNER','ADMIN'])` before this helper runs):
 * end-user DSAR export, impersonation, and the inbound request log.
 */

import type { FastifyRequest } from 'fastify';
import type { ApplicationRole } from '@prisma/client';
import { prisma } from './prisma.js';
import { RekeyError } from './error.js';

export type AppAccessNeed = 'read' | 'write' | 'billing-write';

export interface AppAccess {
  /**
   * How the access was satisfied:
   *  - 'workspace-admin' — caller is OWNER/ADMIN (implicit full access)
   *  - 'legacy-member'   — grandfathered pre-grants membership (read-only)
   *  - ApplicationRole   — MEMBER via an explicit grant on this Application
   */
  level: 'workspace-admin' | 'legacy-member' | ApplicationRole;
}

function notFound(applicationId: string): RekeyError {
  // Don't disclose existence (in another tenant, or behind a missing grant) —
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
  // MEMBER hitting these routes — kept for client back-compat.
  return new RekeyError({
    statusCode: 403,
    code: 'TENANT_ROLE_INSUFFICIENT',
    message: `This action requires one of: OWNER, ADMIN. Your role: ${role}.`,
    fix: 'Ask a workspace owner or admin to perform this action, to upgrade your role, or to grant you an application role (APP_ADMIN / APP_BILLING).',
  });
}

function grantDenied(need: AppAccessNeed, granted: ApplicationRole): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'APP_ACCESS_DENIED',
    message: `Your application role ${granted} does not allow this action (requires ${
      need === 'billing-write' ? 'APP_BILLING or APP_ADMIN' : 'APP_ADMIN'
    }).`,
    fix: 'Ask a workspace owner or admin to raise your application grant via PUT /api/v1/tenant/workspace/members/:membershipId/grants.',
  });
}

/**
 * Assert the Application belongs to the active workspace AND the caller may
 * perform `need` on it. Must run after `requireTenantSession`.
 */
export async function ensureAppAccess(
  req: FastifyRequest,
  applicationId: string,
  need: AppAccessNeed,
): Promise<AppAccess> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { tenantId: true },
  });
  if (!app || app.tenantId !== req.tenantId) throw notFound(applicationId);

  if (req.tenantRole === 'OWNER' || req.tenantRole === 'ADMIN') {
    return { level: 'workspace-admin' };
  }

  // MEMBER — consult grants. Every operator auth middleware attaches
  // tenantMembershipId; the lookup below is a defensive fallback for any
  // future auth path that only sets tenantUser/tenantId.
  let membershipId = req.tenantMembershipId;
  if (!membershipId && req.tenantUser && req.tenantId) {
    const membership = await prisma.tenantMembership.findUnique({
      where: {
        tenantUserId_tenantId: { tenantUserId: req.tenantUser.id, tenantId: req.tenantId },
      },
      select: { id: true },
    });
    membershipId = membership?.id;
  }
  if (!membershipId) {
    throw new RekeyError({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'ensureAppAccess used without requireTenantSession.',
      fix: 'Register requireTenantSession before the route handler.',
    });
  }
  const [grants, membership] = await Promise.all([
    prisma.applicationGrant.findMany({
      where: { tenantMembershipId: membershipId },
      select: { applicationId: true, role: true },
    }),
    prisma.tenantMembership.findUnique({
      where: { id: membershipId },
      select: { legacyWorkspaceRead: true },
    }),
  ]);

  const grant = grants.find((g) => g.applicationId === applicationId);
  if (!grant) {
    // Grandfathered pre-grants membership: workspace-wide read, no writes.
    // The ONLY path that still reaches the old behaviour, and it is now
    // predicated on an explicit column rather than on "this member happens to
    // have no grants" — which is what every new member looks like.
    //
    // `grants.length === 0` as well as the flag, deliberately. Setting a grant
    // clears the flag and the migration clears it for any row that already had
    // one, so "grandfathered AND granted" is unreachable — but if it ever did
    // occur, grants must win, exactly as they did before. This condition is
    // duplicated verbatim in `appAccessScope` below and in
    // `tenant-mcp/operator-tools.ts`; all three have to agree.
    if (grants.length === 0 && membership?.legacyWorkspaceRead === true) {
      if (need === 'read') return { level: 'legacy-member' };
      throw legacyWriteDenied(req.tenantRole ?? 'MEMBER');
    }
    // Default since 2.0.0-rc.3: closed. Same 404 an ungranted Application
    // already returned for a member who held grants elsewhere, so a denied
    // Application stays indistinguishable from an absent one.
    throw notFound(applicationId);
  }

  if (need === 'read') return { level: grant.role };
  if (need === 'billing-write') {
    if (grant.role === 'APP_ADMIN' || grant.role === 'APP_BILLING') return { level: grant.role };
    throw grantDenied(need, grant.role);
  }
  // need === 'write'
  if (grant.role === 'APP_ADMIN') return { level: grant.role };
  throw grantDenied(need, grant.role);
}

export interface AppAccessScope {
  /** false → caller sees every Application in the workspace (OWNER/ADMIN or grandfathered member). */
  restricted: boolean;
  /** Granted application ids (only meaningful when restricted). */
  applicationIds: string[];
  /** applicationId → granted role (only meaningful when restricted). */
  roleByApplicationId: Map<string, ApplicationRole>;
}

/**
 * Which Applications may the caller see at all? Used by the list endpoint
 * (which also feeds the panel sidebar + command palette).
 */
export async function appAccessScope(req: FastifyRequest): Promise<AppAccessScope> {
  if (req.tenantRole === 'OWNER' || req.tenantRole === 'ADMIN' || !req.tenantMembershipId) {
    return { restricted: false, applicationIds: [], roleByApplicationId: new Map() };
  }
  const [grants, membership] = await Promise.all([
    prisma.applicationGrant.findMany({
      where: { tenantMembershipId: req.tenantMembershipId },
      select: { applicationId: true, role: true },
    }),
    prisma.tenantMembership.findUnique({
      where: { id: req.tenantMembershipId },
      select: { legacyWorkspaceRead: true },
    }),
  ]);
  // Grandfathered pre-grants membership — workspace-wide read. Zero grants on
  // its own no longer widens the scope: since 2.0.0-rc.3 it narrows it to
  // nothing, which is what a new MEMBER invitation is supposed to produce.
  if (grants.length === 0 && membership?.legacyWorkspaceRead === true) {
    return { restricted: false, applicationIds: [], roleByApplicationId: new Map() };
  }
  return {
    restricted: true,
    applicationIds: grants.map((g) => g.applicationId),
    roleByApplicationId: new Map(grants.map((g) => [g.applicationId, g.role])),
  };
}

/**
 * APP_BILLING members manage money, not sign-in: blank out the auth/OAuth
 * configuration on Application payloads served to them ("can see revenue and
 * manage plans but not touch auth" — roadmap #8).
 */
export function redactApplicationForBilling<
  T extends { authConfig?: unknown; oauthConfig?: unknown },
>(application: T): T {
  return { ...application, authConfig: {}, oauthConfig: {} };
}

/**
 * Remove the encrypted-credential blobs from an Application payload.
 *
 * `Application` carries `oauthCredentialsCiphertext` (OAuth client secrets),
 * `emailCredentialsCiphertext` (SMTP password) and
 * `billingCredentialsCiphertext` (the payment-provider API key and webhook
 * secret) as columns on the row. Routes that returned the row served all of them — an
 * external audit found the two credential blobs reaching a read-only
 * APP_VIEWER, which is a grant-scoped audience that only became reachable in
 * 2.0.0-rc.3.
 *
 * The plaintext is not exposed, so this is not a live credential leak. It is
 * still wrong on two counts: the dedicated endpoints deliberately redact these
 * (`email-config` returns a `hasCustomCredentials` boolean and nothing else),
 * so the app-detail route contradicted its own module's discipline; and
 * ciphertext in a browser is an offline attack surface that becomes a real
 * leak the day `ENCRYPTION_KEY` does. Nothing outside the API can use these
 * values for anything, so there is no reason to send them.
 *
 * Applied to every audience, not just the restricted ones — an OWNER has no
 * more use for a ciphertext blob than a viewer does.
 */
export function stripApplicationSecrets<T extends Record<string, unknown>>(application: T): T {
  const {
    oauthCredentialsCiphertext: _oauth,
    emailCredentialsCiphertext: _email,
    // The audit only caught the two above; this one is the same column class
    // and the most sensitive of the three — the payment-provider API key and
    // webhook secret.
    billingCredentialsCiphertext: _billing,
    ...safe
  } = application as Record<string, unknown>;
  return safe as T;
}
