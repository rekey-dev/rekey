/**
 * Per-application access control for operator (tenant-session) routes.
 *
 * Replaces the old per-file `ensureAppInTenant` helper on every
 * /api/v1/tenant/applications/:id/* route. One call answers BOTH questions:
 *   1. Does this Application belong to the active workspace? (404 otherwise,
 *      same non-disclosure posture as before)
 *   2. Is the calling operator allowed to do `need` on it?
 *
 * Permission model (roadmap #8, v1, see prisma `ApplicationGrant`):
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
 * licences, organizations and email logs, 31 read endpoints on an Application
 * nobody had granted them. The accommodation is now an explicit per-membership
 * flag (`TenantMembership.legacyWorkspaceRead`) that only the backfill sets,
 * and the DEFAULT for every new membership is closed.
 *
 * Route classification ("need"):
 *   'read'         , GET surfaces (lists, stats, configs, logs).
 *   'billing-write', mutations on the billing catalog: plans, plan
 *                     entitlements, coupons, manual credit grants.
 *   'write'        , every other mutation: auth config, API keys, billing
 *                     credentials/config, OAuth config, end-users, licenses,
 *                     usage meters, organizations, webhooks, email, access
 *                     controls, session rotation.
 *
 * Routes that stay OWNER/ADMIN-only regardless of grants (extra-sensitive,
 * gated by `requireTenantRole(['OWNER','ADMIN'])` before this helper runs):
 * end-user DSAR export, impersonation, and the inbound request log.
 *
 * The decision is implemented ONCE, in `./access-context.ts`, over a plain
 * context rather than a request, that is what lets the MCP handlers share it
 * instead of carrying their own copy. This file keeps the request-shaped
 * adapters every REST route calls.
 */

import type { FastifyRequest } from 'fastify';
import {
  accessContextFromRequest,
  accessScope,
  applicationAccess,
  type AppAccess,
  type AppAccessNeed,
  type AppAccessScope,
} from './access-context.js';
import { NO_SCOPES } from './operator-scopes.js';

// These two are the request-shaped adapters over the decision in
// ./access-context.ts; names, signatures and observable behaviour unchanged.
export type { AppAccess, AppAccessNeed, AppAccessScope };

/**
 * Assert the Application belongs to the active workspace AND the caller may
 * perform `need` on it. Must run after `requireTenantSession`.
 */
export async function ensureAppAccess(
  req: FastifyRequest,
  applicationId: string,
  need: AppAccessNeed,
): Promise<AppAccess> {
  // The scope this route needs is its own declaration (lib/route-access.ts),
  // so the 128 call sites keep their signature and every one is gated.
  const declared = req.routeOptions?.config?.access;
  const access = await applicationAccess(
    await accessContextFromRequest(req),
    applicationId,
    need,
    declared,
  );
  // For the request log: the scope that admitted this, if a gate ran. An
  // OWNER/ADMIN is never gated, so recording the route's scope for them
  // would claim an authority check that did not happen.
  req.accessDecision = {
    scope:
      access.level !== 'workspace-admin' && declared !== undefined && 'scope' in declared ? declared.scope : null,
    level: access.level,
  };
  return access;
}

/**
 * Which Applications may the caller see at all? Used by the list endpoint
 * (which also feeds the panel sidebar + command palette).
 */
export async function appAccessScope(req: FastifyRequest): Promise<AppAccessScope> {
  // Mirrors the old inline check: an OWNER/ADMIN, or a request with no
  // membership id, is unrestricted. The adapter's fallback lookup is not
  // wanted here, the old code never did one for the scope question.
  if (req.tenantRole === 'OWNER' || req.tenantRole === 'ADMIN' || !req.tenantMembershipId) {
    return { restricted: false, applicationIds: [], roleByApplicationId: new Map() };
  }
  return accessScope({
    tenantId: req.tenantId!,
    role: req.tenantRole!,
    membershipId: req.tenantMembershipId,
    scopes: req.tenantScopes ?? NO_SCOPES,
  });
}

/**
 * APP_BILLING members manage money, not sign-in: blank out the auth/OAuth
 * configuration on Application payloads served to them ("can see revenue and
 * manage plans but not touch auth", roadmap #8).
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
 * secret) as columns on the row. Routes that returned the row served all of them, an
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
 * Applied to every audience, not just the restricted ones, an OWNER has no
 * more use for a ciphertext blob than a viewer does.
 */
export function stripApplicationSecrets<T extends Record<string, unknown>>(application: T): T {
  const {
    oauthCredentialsCiphertext: _oauth,
    emailCredentialsCiphertext: _email,
    // The audit only caught the two above; this one is the same column class
    // and the most sensitive of the three, the payment-provider API key and
    // webhook secret.
    billingCredentialsCiphertext: _billing,
    ...safe
  } = application as Record<string, unknown>;
  return safe as T;
}
