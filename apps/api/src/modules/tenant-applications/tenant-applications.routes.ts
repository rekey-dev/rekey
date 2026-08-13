/**
 * Tenant-scoped admin endpoints.
 *
 * These are the routes the panel calls day-to-day. Same operations as
 * /api/v1/admin/applications/* but scoped to the operator's active workspace
 * — they only see / mutate Applications that belong to their Tenant.
 *
 * Implementation strategy: lean on the existing services
 * (`applicationsService`, `apiKeysService`, `plansService`,
 * `couponsService`) and just enforce the tenant-ownership guard at the
 * route layer. We deliberately don't duplicate service logic.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applicationsService } from '../applications/applications.service.js';
import { apiKeysService } from '../api-keys/api-keys.service.js';
import { planCheckoutReadiness } from '../plans/plan-readiness.js';
import { plansService } from '../plans/plans.service.js';
import { couponsService } from '../coupons/coupons.service.js';
import {
  billingCredentialsService,
  type BillingProviderName,
} from '../billing/credentials.service.js';
import { registerProviderWebhook } from '../billing/webhook-registration.js';
import {
  providerNameSchema,
  registryNames,
  getModule,
  credentialDataSchema,
  providerDescriptor,
} from '../billing/providers/registry.js';
import { billingStatsService } from '../billing/stats.service.js';
import { oauthService } from '../oauth/oauth.service.js';
import { licensesService } from '../licenses/licenses.service.js';
import { usageService } from '../usage/usage.service.js';
import { creditsService } from '../credits/credits.service.js';
import { prisma } from '../../lib/prisma.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { listApiRequests } from '../../lib/request-log.js';
import { CouponDiscountType, type LicenseKind } from '@prisma/client';
import { AppEnvironmentSchema, BillingProviderSchema, GrantCreditsRequestSchema } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import { hashPassword } from '../../lib/passwords.js';
import { assertMetadataWithinLimit } from '../auth/auth.service.js';
import { assertEndUserQuota } from '../../lib/tenant-limits.js';
import { endUserRolesService } from '../end-user-roles/end-user-roles.service.js';
import { organizationsService } from '../organizations/organizations.service.js';
import { entitlementsService } from '../billing/entitlements.service.js';
import {
  requireTenantSession,
  requireTenantRole,
} from '../../middleware/tenant-session.js';
import {
  ensureAppAccess,
  appAccessScope,
  redactApplicationForBilling,
  stripApplicationSecrets,
} from '../../lib/app-access.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { refreshCorsOrigins } from '../../lib/cors-origins.js';
import { mcpIssuer } from '../mcp/oauth.service.js';
import { eraseEndUser } from './end-user-erasure.service.js';
import { billingService } from '../billing/billing.service.js';
import { emitDetached } from '../webhooks/webhook.service.js';
import { euLoginLockScope, getScopeLockState, LOGIN_POLICY } from '../../lib/brute-force.js';
import { moneyAmount, positiveBoundedInt } from '../../lib/bounded-int.js';
import { ok, okPage, okArray, okFlag, errs, ref, type JsonSchema } from '../../lib/openapi.js';

// ---------------------------------------------------------------------------
// Shared error groups
//
// Every route in this file sits behind `requireTenantSession` (the `onRequest`
// hook registered below), so TENANT_SESSION_{MISSING,INVALID} (401) and
// TENANT_MEMBERSHIP_REVOKED (403) are possible on every operation. Most routes
// additionally call `ensureAppAccess(req, id, need)` (see lib/app-access.ts),
// which adds APPLICATION_NOT_FOUND (404, also the non-disclosure response for
// "no grant on this app") and, for 'write'/'billing-write' needs, a 403 that is
// either the legacy TENANT_ROLE_INSUFFICIENT (grant-less MEMBER) or the
// grant-aware APP_ACCESS_DENIED (MEMBER with an insufficient grant role).
// ---------------------------------------------------------------------------

/** Every route: the `requireTenantSession` onRequest hook. */
const TENANT_SESSION_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or TENANT_SESSION_INVALID — ' +
    'the token is invalid, expired, or the operator account no longer exists.',
  403: 'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of this workspace.',
} as const;

/** Routes calling `ensureAppAccess(req, id, 'read')`. */
const APP_READ_ERRORS = {
  ...TENANT_SESSION_ERRORS,
  404:
    'APPLICATION_NOT_FOUND — no application with that id in this workspace (also returned to a ' +
    'MEMBER with per-app grants who holds no grant on it — same non-disclosure posture).',
} as const;

/** Routes calling `ensureAppAccess(req, id, 'write')`. */
const APP_WRITE_ERRORS = {
  401: TENANT_SESSION_ERRORS[401],
  403:
    'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of this workspace; or ' +
    'TENANT_ROLE_INSUFFICIENT — a legacy MEMBER (zero application grants) attempted a write; ' +
    "or APP_ACCESS_DENIED — the operator's grant on this Application (below APP_ADMIN) does " +
    'not permit this action.',
  404: APP_READ_ERRORS[404],
} as const;

/** Routes calling `ensureAppAccess(req, id, 'billing-write')`. */
const APP_BILLING_WRITE_ERRORS = {
  401: TENANT_SESSION_ERRORS[401],
  403:
    'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of this workspace; or ' +
    'TENANT_ROLE_INSUFFICIENT — a legacy MEMBER (zero application grants) attempted a billing ' +
    "write; or APP_ACCESS_DENIED — the operator's grant on this Application (needs APP_BILLING " +
    'or APP_ADMIN) does not permit this action.',
  404: APP_READ_ERRORS[404],
} as const;

/** Routes additionally gated by `requireTenantRole(['OWNER','ADMIN'])` before any app-access check. */
const OWNER_ADMIN_ONLY_ERRORS = {
  401: TENANT_SESSION_ERRORS[401],
  403:
    'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of this workspace; or ' +
    'TENANT_ROLE_INSUFFICIENT — the operator is a MEMBER (this route requires OWNER or ADMIN, ' +
    'no grant unlocks it).',
} as const;

// Per-route access control: `ensureAppAccess(req, appId, need)` replaces the
// old `ensureAppInTenant` helper. It both confirms the Application belongs to
// the active workspace (404 otherwise, same non-disclosure posture) AND
// enforces per-application grants for workspace MEMBERs. Needs in this file:
//   'read'          — every GET surface
//   'billing-write' — plans, plan entitlements, coupons, manual credit grants
//                     (APP_BILLING or APP_ADMIN grant, or OWNER/ADMIN)
//   'write'         — every other mutation (APP_ADMIN grant, or OWNER/ADMIN)
// Extra-sensitive routes (request log, DSAR export, impersonation) addition-
// ally keep requireTenantRole(['OWNER','ADMIN']) — no grant unlocks those.
// See lib/app-access.ts for the full matrix.

/**
 * Live failed-sign-in / lockout state for one end-user, in the shape the
 * operator surfaces have always published.
 *
 * These two fields used to be read straight off `EndUser.{failedSignInAttempts,
 * lockedUntil}`. Lockout moved to the Redis brute-force limiter and nothing has
 * written those columns since, so the end-user detail page reported "Lockout:
 * none" for an account that was demonstrably locked — an operator investigating
 * a "I can't sign in" complaint was shown the opposite of the truth. The
 * columns are gone now; both fields are sourced from the lock itself.
 *
 * `failedSignInAttempts` is honest but blunt, and it is worth knowing why:
 * `registerFailure` DELETES the failure counter at the instant it sets the
 * lock, so there is no surviving count for a locked account. Below the
 * threshold we report the real counter. Once locked, the only true statement
 * left is "at least `threshold` failures", so we report the threshold — the
 * same convention `adminMetricsService.lockedAccounts` already uses, and a
 * documented floor rather than an invented number.
 *
 * `lockedUntil` is reconstructed from the key's remaining TTL, so it drifts by
 * at most a second against the value the limiter will actually enforce.
 */
async function endUserLockState(
  applicationId: string,
  email: string,
): Promise<{ failedSignInAttempts: number; lockedUntil: string | null }> {
  const state = await getScopeLockState(euLoginLockScope(applicationId, email));
  // `null` = the store could not be read. Report no lock rather than 503-ing a
  // whole detail page; sign-in itself is failing closed during the same outage,
  // so nobody is getting in on the strength of this badge. See
  // `getScopeLockState` for the full rationale.
  if (state === null) return { failedSignInAttempts: 0, lockedUntil: null };
  if (state.lockedForSec === null) {
    return { failedSignInAttempts: state.failuresInWindow, lockedUntil: null };
  }
  return {
    failedSignInAttempts: LOGIN_POLICY.threshold,
    lockedUntil: new Date(Date.now() + state.lockedForSec * 1000).toISOString(),
  };
}

// ---- request shapes (mirror the admin routes) ----

const AppParam = z.object({ id: z.string().min(1) });
const KeyIdParam = z.object({ id: z.string().min(1), keyId: z.string().min(1) });
const PlanSlugParam = z.object({ id: z.string().min(1), slug: z.string().min(1) });
const CouponCodeParam = z.object({ id: z.string().min(1), code: z.string().min(1) });

const CreateAppBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(40),
  environment: AppEnvironmentSchema.optional(),
  billingProvider: BillingProviderSchema.optional(),
  enableBilling: z.boolean().optional(),
});

const CreateKeyBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});

const CreatePlanBody = z.object({
  slug: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  amount: moneyAmount(),
  currency: z.string().length(3).optional(),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  kind: z.enum(['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT']).optional(),
  licenseKind: z.enum(['PERPETUAL', 'TIMED', 'SEATS']).optional(),
  licenseSeatsAllowed: positiveBoundedInt().optional(),
  licenseDurationDays: positiveBoundedInt().optional(),
  meterSlug: z.string().min(1).max(40).optional(),
  pricePerUnitCents: moneyAmount().optional(),
  creditsAmount: positiveBoundedInt().optional(),
  // Free trial length. Bounded at a year: a "trial" longer than that is a free
  // plan wearing a trial's name, and the bound stops a typo (365000) becoming
  // a subscription nobody ever gets charged for.
  trialDays: z.number().int().min(1).max(365).optional(),
  metadata: z.record(z.unknown()).optional(),
})
  .refine((b) => b.trialDays === undefined || (b.kind ?? 'SUBSCRIPTION') === 'SUBSCRIPTION', {
    // A trial converts into a recurring charge. A credit pack or a perpetual
    // licence has nothing to convert into, so a trial on one is not a
    // restriction worth explaining after the fact — it is a mistake.
    message: 'trialDays applies to SUBSCRIPTION plans only.',
    path: ['trialDays'],
  });
/**
 * Plan edit. Every field optional, at least one required — this used to accept
 * `{ active }` and nothing else, which left a plan the provider had refused
 * with no repair at all: the slug was taken, so it could not be re-created, and
 * nothing on it could be corrected.
 *
 * Price fields are accepted HERE and refused in the service when the plan is
 * already registered (`PLAN_PRICE_IMMUTABLE`) — the rule depends on stored
 * state, so it cannot live in a body schema.
 */
const UpdatePlanBody = z
  .object({
    active: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
    amount: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    interval: z.enum(['MONTH', 'YEAR']).optional(),
    // 0 removes the trial; null would need a different encoding through the
    // JSON schema, and "no trial" and "zero days of trial" are the same thing.
    trialDays: z.number().int().min(0).max(365).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Send at least one field to change.',
  });

const CreateCouponBody = z.object({
  code: z.string().min(1).max(40),
  discountType: z.enum(['PERCENT', 'AMOUNT']),
  amountOff: moneyAmount(),
  currency: z.string().length(3).optional(),
  planSlugs: z.array(z.string().min(1).max(40)).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  maxRedemptions: positiveBoundedInt().optional(),
  maxRedemptionsPerUser: positiveBoundedInt().optional(),
});
const CouponActiveBody = z.object({ active: z.boolean() });

/** Mounted under /api/v1/tenant/applications. */
export async function tenantApplicationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  // ---------- Applications ----------

  app.get(
    '/',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'List Applications in the active workspace',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(
            ref('Application'),
            'A page of Applications in the active workspace, newest first. A MEMBER with ' +
              'per-app grants sees only granted Applications (APP_BILLING entries redacted).',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...TENANT_SESSION_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      // MEMBERs with per-app grants only see their granted Applications —
      // this single filter also scopes the panel sidebar + command palette,
      // which are both fed by this endpoint.
      const scope = await appAccessScope(req);
      const scopeIds = scope.restricted ? { ids: scope.applicationIds } : {};
      const [apps, total] = await Promise.all([
        applicationsService.list(req.tenantId!, { take, skip, ...scopeIds }),
        // Counted through the SAME grant scoping, not over the whole
        // workspace: a MEMBER told there are 40 Applications when they may
        // read 3 has been handed an existence oracle, not a page count.
        applicationsService.count(req.tenantId!, scopeIds),
      ]);
      return {
        success: true,
        // Secrets stripped for EVERY audience; the billing redaction is the
        // extra, role-specific layer on top.
        data: paged(
          apps.map((a) =>
            stripApplicationSecrets(
              scope.roleByApplicationId.get(a.id) === 'APP_BILLING'
                ? redactApplicationForBilling(a)
                : a,
            ),
          ),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.get(
    '/check-slug',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Check if an Application slug is available',
        description:
          'Used by the "Create application" form for live availability feedback. ' +
          'Returns the same shape regardless — never leaks WHICH tenant owns a taken slug.',
        querystring: {
          type: 'object',
          required: ['slug'],
          properties: { slug: { type: 'string', minLength: 1, maxLength: 40 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                slug: { type: 'string' },
                available: { type: 'boolean' },
                reason: {
                  type: 'string',
                  enum: ['invalid', 'taken'],
                  description: 'Present only when `available` is false.',
                },
              },
              required: ['slug', 'available'],
            },
            'Slug availability. Never discloses which tenant owns a taken slug.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `slug` missing or outside 1-40 chars.',
            ...TENANT_SESSION_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { slug } = z.object({ slug: z.string().min(1).max(40) }).parse(req.query);
      const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
      if (!SLUG_RE.test(slug)) {
        return {
          success: true,
          data: { slug, available: false, reason: 'invalid' as const },
        };
      }
      const existing = await prisma.application.findUnique({
        where: { slug },
        select: { id: true },
      });
      return {
        success: true,
        data: existing
          ? { slug, available: false, reason: 'taken' as const }
          : { slug, available: true },
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Get one Application (must belong to the active workspace)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(
            {
              allOf: [
                ref('Application'),
                {
                  type: 'object',
                  properties: {
                    mcpUrl: {
                      type: 'string',
                      description:
                        'Externally-reachable hosted MCP server URL, derived from ' +
                        'PUBLIC_WEBHOOK_BASE_URL/API_URL (not the in-cluster REKEY_URL).',
                    },
                  },
                  required: ['mcpUrl'],
                },
              ],
            },
            'The application. An operator holding only the APP_BILLING grant gets authConfig ' +
              'and oauthConfig redacted to {}.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      const access = await ensureAppAccess(req, id, 'read');
      const application = await applicationsService.get(id, { tenantId: req.tenantId! });
      // Surface the PUBLIC MCP URL (derived from PUBLIC_WEBHOOK_BASE_URL/API_URL
      // on the API side) so the panel shows the externally-reachable host, not
      // its own in-cluster REKEY_URL (e.g. http://api:3030).
      const data = { ...application, mcpUrl: mcpIssuer(application.slug) };
      // Billing managers see money, not sign-in: hide the auth/OAuth config.
      return {
        success: true,
        data: stripApplicationSecrets(
          access.level === 'APP_BILLING' ? redactApplicationForBilling(data) : data,
        ),
      };
    },
  );

  app.get(
    '/:id/stats',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Dashboard stats for one Application (Overview tiles)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'End-user totals + 30-day sign-up trend, security-events summary, billing snapshot, ' +
          'and a usage/credits roll-up. Scoped to the active workspace.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                users: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    verified: { type: 'integer' },
                    newLast7d: { type: 'integer' },
                    newLast30d: { type: 'integer' },
                    signupTrend: {
                      type: 'array',
                      description: 'One entry per day for the last 30 days (oldest first), gap-filled with zeroes.',
                      items: {
                        type: 'object',
                        properties: {
                          date: { type: 'string', format: 'date' },
                          count: { type: 'integer' },
                        },
                        required: ['date', 'count'],
                      },
                    },
                  },
                  required: ['total', 'verified', 'newLast7d', 'newLast30d', 'signupTrend'],
                },
                security: {
                  type: 'object',
                  properties: {
                    eventsLast30d: { type: 'integer' },
                    signInsLast30d: { type: 'integer' },
                    signUpsLast30d: { type: 'integer' },
                  },
                  required: ['eventsLast30d', 'signInsLast30d', 'signUpsLast30d'],
                },
                billing: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    activeSubscriptions: { type: 'integer' },
                    plansActive: { type: 'integer' },
                    plansTotal: { type: 'integer' },
                  },
                  required: ['enabled', 'activeSubscriptions', 'plansActive', 'plansTotal'],
                },
                usage: {
                  type: 'object',
                  properties: {
                    creditsOutstanding: { type: 'integer' },
                    usageLast30d: { type: 'number' },
                  },
                  required: ['creditsOutstanding', 'usageLast30d'],
                },
              },
              required: ['users', 'security', 'billing', 'usage'],
            },
            'Overview-tile dashboard stats for one Application.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await applicationsService.stats(id) };
    },
  );

  app.get(
    '/:id/requests',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Recent inbound API requests for an Application',
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\nRequires **read** access to ' +
          'this Application — OWNER/ADMIN, or a MEMBER holding any grant on it (grant-less ' +
          'legacy members keep workspace-wide read).\n\n' +
          "Requests made to this Application's public API with its secret key, newest " +
          'first (status, route, duration, IP). Recorded best-effort by a global ' +
          'response hook; the table is capped per app by a periodic pruner, so this is ' +
          'a convenience tail, not a billing-grade audit trail. Paginated via ?limit&offset.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          // `page.total` is what the pruner has left for this Application, not
          // every request it has ever served — the description says so. It is
          // still the honest answer to "is there another page", which the old
          // `{requests: [...]}` wrapper could not give at all.
          200: okPage(
            ref('ApiRequestLog'),
            "A page of recent inbound requests to this Application's public API, newest first.",
          ),
          ...errs({ ...OWNER_ADMIN_ONLY_ERRORS, 404: APP_READ_ERRORS[404] }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await listApiRequests({ applicationId: id, take, skip });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Create an Application in the active workspace',
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\n' +
          'The Application is the isolation boundary in Rekey — every row carries its ' +
          '`applicationId`. Create a separate Application per environment rather than ' +
          'mixing real and rehearsal data in one: `environment` is fixed here and cannot ' +
          'be changed afterwards.',
        body: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            environment: {
              type: 'string',
              enum: ['PRODUCTION', 'STAGING', 'DEVELOPMENT'],
              default: 'DEVELOPMENT',
              description:
                'What this Application is, fixed at creation and **immutable** — there is no ' +
                'endpoint that changes it. Defaults to DEVELOPMENT. A PRODUCTION app mints ' +
                'rp_live_ keys, others mint rp_test_ — the prefix is descriptive. Environment ' +
                'does NOT restrict which billing credentials the app may hold. To go live, ' +
                'create a PRODUCTION Application.',
            },
            billingProvider: { type: 'string', enum: registryNames },
            enableBilling: {
              type: 'boolean',
              description: 'Create with the billing surface enabled. Defaults false.',
            },
          },
        },
        response: {
          201: ok(ref('Application'), 'The created application.'),
          ...errs({
            400:
              'VALIDATION_ERROR — a field failed schema validation; or ' +
              'APPLICATION_SLUG_INVALID — the slug is not URL-safe.',
            ...OWNER_ADMIN_ONLY_ERRORS,
            403:
              OWNER_ADMIN_ONLY_ERRORS[403] +
              ' Or TENANT_QUOTA_EXCEEDED — creating a PRODUCTION application would exceed ' +
              "the workspace's `maxProductionApps`.",
            409: 'APPLICATION_SLUG_TAKEN — another application already uses that slug (slugs are unique deployment-wide).',
          }),
        },
      },
    },
    async (req, reply) => {
      const body = CreateAppBody.parse(req.body);
      const created = await applicationsService.create({
        tenantId: req.tenantId!,
        name: body.name,
        slug: body.slug,
        ...(body.environment !== undefined && { environment: body.environment }),
        ...(body.billingProvider !== undefined && { billingProvider: body.billingProvider }),
        ...(body.enableBilling !== undefined && { enableBilling: body.enableBilling }),
      });
      return reply
        .status(201)
        .send({ success: true, data: stripApplicationSecrets(created) });
    },
  );

  // ---------- Auth config (which methods are enabled) ----------

  app.patch(
    '/:id/auth-config',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Patch the auth configuration for an Application',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Toggle which auth methods are enabled (`password`, `magic_link`, …), set ' +
          '`signupEnabled=false` for invite-only apps, set the password minimum length, ' +
          'or update the redirect URL allowlist. OAuth provider availability is implicit ' +
          'from the per-provider oauth-config endpoints.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            methods: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 } },
            passwordMinLength: { type: 'integer', minimum: 8, maximum: 128 },
            redirectUrls: { type: 'array', items: { type: 'string', format: 'uri' } },
            appUrl: {
              // `nullable: true`, not `type: ['string', 'null']`. The draft-07
              // type-array form is not valid OpenAPI 3.0 (what this document
              // declares), so it made the published openapi.json fail every
              // real validator. Fastify's ajv treats the two identically at
              // runtime, so this is a spelling change, not a contract change.
              type: 'string',
              nullable: true,
              description:
                "Base URL of your own application — what transactional emails link back to " +
                '(the welcome mail CTA, and the base for reset/verify/magic-link URLs when the ' +
                'SDK call does not supply one). Send null or "" to clear it. When unset, and ' +
                'nothing else resolves (first redirectUrl origin, then DEFAULT_APP_URL), emails ' +
                'render WITHOUT the call-to-action button rather than with a broken link.',
            },
            organizationsEnabled: { type: 'boolean' },
            passwordBreachCheckEnabled: { type: 'boolean', description: 'HIBP Pwned-Passwords breach check at sign-up/reset/change. Default true.' },
            sendVerificationEmailOnSignUp: {
              type: 'boolean',
              description:
                'Send the email-verification link automatically on password sign-up, alongside the welcome mail. Default true. Delivery is best-effort — a failed send never fails the sign-up.',
            },
            requireEmailVerification: {
              type: 'boolean',
              description:
                'Refuse password sign-in with 403 EMAIL_NOT_VERIFIED until the end-user confirms their address. Default false; turning it on applies to existing unverified accounts immediately.',
            },
            signupEnabled: { type: 'boolean', description: 'Legacy alias for signupMode (false ⇔ invite_only). Prefer signupMode.' },
            signupMode: {
              type: 'string',
              enum: ['public', 'secret_only', 'invite_only'],
              description:
                'Who may create end-users: public (any key), secret_only (server-side secret key only — publishable key refused with SIGNUP_REQUIRES_SECRET_KEY), or invite_only (no public sign-up).',
            },
            mfa: { type: 'string', enum: ['off', 'optional', 'required'], description: 'End-user 2FA policy.' },
            mcpEnabled: { type: 'boolean', description: 'Expose a hosted MCP server + OAuth AS for this app.' },
            oidcEnabled: {
              type: 'boolean',
              description:
                'Act as an OpenID Connect provider: serve /.well-known/openid-configuration, ' +
                'issue an id_token when the openid scope is granted, and expose /oauth/userinfo. ' +
                'Independent of mcpEnabled. The `email` scope additionally needs ' +
                'requireEmailVerification — Rekey will not assert an address nobody proved.',
            },
            dynamicClientRegistration: {
              type: 'boolean',
              description:
                'Allow anyone to register an OAuth client with POST /oauth/register (RFC 7591 ' +
                'open registration). Default true — MCP clients self-register and there is no ' +
                'operator-side client-creation surface yet. Turn it off once your relying ' +
                'parties are registered: open registration on a public IdP lets anyone put a ' +
                "password prompt on this deployment's issuer origin.",
            },
            tokenAlg: {
              type: 'string',
              enum: ['HS256', 'RS256'],
              description:
                'Signature alg for NEW end-user access tokens. RS256 tokens verify offline ' +
                'against GET /.well-known/jwks.json; HS256 (default) requires the API. ' +
                'Switching never breaks outstanding tokens — the API verifies both.',
            },
          },
        },
        response: {
          200: ok(
            { type: 'object', properties: { authConfig: ref('AuthConfig') }, required: ['authConfig'] },
            'The Application, patched auth configuration.',
          ),
          ...errs({ 400: 'VALIDATION_ERROR — a field failed schema validation.', ...APP_WRITE_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      // `.strict()`, matching the billing-config patch below. Every key is
      // optional, so a non-strict object accepted `{"mfaa":"required",
      // "tokenAlgorithm":"none"}`, dropped both, and answered 200 with an
      // unchanged authConfig — a one-character typo silently no-opping this
      // Application's MFA policy and token signing algorithm while telling
      // the caller it worked. A patch body whose keys are ALL optional has no
      // shape left to fail on except the key names, so those have to be the
      // check. Unknown keys now surface as 400 VALIDATION_ERROR naming the
      // offender (see the ZodError branch in lib/error.ts).
      const body = z
        .object({
          methods: z.array(z.string().min(1).max(40)).optional(),
          passwordMinLength: z.number().int().min(8).max(128).optional(),
          redirectUrls: z.array(z.string().url()).optional(),
          // A URL, or null/'' to clear. Validated here rather than left to the
          // AuthConfigSchema merge so a bad value is a 400 with a field path
          // instead of a confusing schema error on an unrelated key.
          appUrl: z.union([z.string().url(), z.literal(''), z.null()]).optional(),
          organizationsEnabled: z.boolean().optional(),
          passwordBreachCheckEnabled: z.boolean().optional(),
          sendVerificationEmailOnSignUp: z.boolean().optional(),
          requireEmailVerification: z.boolean().optional(),
          signupEnabled: z.boolean().optional(),
          signupMode: z.enum(['public', 'secret_only', 'invite_only']).optional(),
          mfa: z.enum(['off', 'optional', 'required']).optional(),
          mcpEnabled: z.boolean().optional(),
          oidcEnabled: z.boolean().optional(),
          dynamicClientRegistration: z.boolean().optional(),
          tokenAlg: z.enum(['HS256', 'RS256']).optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const updated = await applicationsService.updateAuthConfig({
        applicationId: id,
        patch: body,
      });
      // Audit the auth-config mutation — security-sensitive (toggles auth
      // methods, signup, MFA policy, and the token signing alg). Record the
      // exact fields touched (incl. a tokenAlg switch) for forensics.
      void recordSecurityEvent({
        type: 'app.auth_config_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { changed: Object.keys(body), ...(body.tokenAlg !== undefined && { tokenAlg: body.tokenAlg }) },
      });
      return { success: true, data: { authConfig: updated.authConfig } };
    },
  );

  app.patch(
    '/:id/billing-config',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Toggle billing for an Application',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Master switch. When disabled, the public billing API (checkout, ' +
          'subscriptions, coupons) returns 403 BILLING_DISABLED and the panel hides ' +
          'the Billing group. Default off for new apps.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            dunningEnabled: { type: 'boolean', description: 'Failed-payment recovery: reminders (day 0/3/7) + day-14 auto-cancel for PAST_DUE subscriptions. Off by default; opt in per app.' },
            billingSubject: { type: 'string', enum: ['user', 'org'], description: 'Bill the individual end-user or their organization (owner+beneficiary).' },
            defaultPlanSlug: {
              // See the note on `appUrl` in the auth-config route above.
              type: 'string',
              nullable: true,
              description:
                'Free-tier fallback. Slug of an active plan whose FEATURE flags + included usage quota apply to end-users with no active subscription. null clears it.',
            },
          },
        },
        response: {
          200: ok(
            { type: 'object', properties: { billingConfig: ref('BillingConfig') }, required: ['billingConfig'] },
            'The Application, patched billing configuration.',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR — an unknown key or a field failed schema validation; or ' +
              'DEFAULT_PLAN_NOT_FOUND — `defaultPlanSlug` does not match an active plan on this Application.',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      // `.strict()`, not the zod default. Every key here is optional, so a
      // non-strict object accepted `{ dunningEnabld: true }`, silently dropped
      // it, and answered 200 — an operator turning dunning on, being told it
      // worked, and getting nothing. A patch body whose keys are all optional
      // has no shape left to fail on except the key names, so those have to be
      // the check. Unknown keys now surface as 400 VALIDATION_ERROR naming the
      // offender (see the ZodError branch in lib/error.ts).
      const body = z
        .object({
          enabled: z.boolean().optional(),
          dunningEnabled: z.boolean().optional(),
          billingSubject: z.enum(['user', 'org']).optional(),
          defaultPlanSlug: z.string().min(1).nullable().optional(),
        })
        .strict()
        .parse(req.body ?? {});
      // Reject a typo'd free-tier slug so it can't silently disable the tier.
      if (typeof body.defaultPlanSlug === 'string') {
        const plan = await prisma.plan.findFirst({
          where: { applicationId: id, slug: body.defaultPlanSlug, active: true },
          select: { id: true },
        });
        if (!plan) {
          throw new RekeyError({
            statusCode: 400,
            code: 'DEFAULT_PLAN_NOT_FOUND',
            message: `No active plan "${body.defaultPlanSlug}" in this Application.`,
            fix: 'Pass the slug of an existing active plan to use as the free tier, or null to clear it.',
          });
        }
      }
      const updated = await applicationsService.updateBillingConfig({
        applicationId: id,
        patch: body,
      });
      void recordSecurityEvent({
        type: 'app.billing_toggled',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        // Audit every field the operator actually changed — the route now
        // patches enabled / dunningEnabled / billingSubject / defaultPlanSlug.
        metadata: { changed: Object.keys(body), ...body },
      });
      return { success: true, data: { billingConfig: updated.billingConfig } };
    },
  );

  // ---------- API keys ----------

  app.get(
    '/:id/api-keys',
    {
      schema: {
        tags: ['Tenant · API Keys'],
        security: [{ tenantSession: [] }],
        summary: 'List active API keys for an application',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          // Bounded by construction: `create()` refuses a 26th active key
          // (API_KEY_LIMIT_REACHED, cap 25), so this cannot grow unbounded.
          200: okArray(ref('ApiKey'), 'Active (non-revoked) API keys for this Application.'),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await apiKeysService.listForApplication(id) };
    },
  );

  app.post(
    '/:id/api-keys',
    {
      // Generic Idempotency-Key header support (scoped to the workspace) — a
      // retried mint would otherwise create a second key whose rawKey nobody saw.
      config: { idempotency: true },
      schema: {
        tags: ['Tenant · API Keys'],
        security: [{ tenantSession: [] }],
        summary: 'Mint an API key (raw shown once)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          "The key's prefix follows the Application's `environment`: PRODUCTION mints " +
          '`rp_live_…`, STAGING/DEVELOPMENT mint `rp_test_…`. It is not selectable.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            scopes: { type: 'array', items: { type: 'string' } },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                apiKey: ref('ApiKey'),
                rawKey: { type: 'string', description: 'Shown exactly once — store it now.' },
                warning: { type: 'string' },
              },
              required: ['apiKey', 'rawKey', 'warning'],
            },
            'The minted key metadata plus the raw secret (shown once).',
          ),
          ...errs({
            400:
              'API_KEY_EXPIRY_IN_PAST — `expiresAt` is not in the future; or ' +
              'API_KEY_LIMIT_REACHED — the Application already has 25 active keys; or ' +
              'VALIDATION_ERROR — a field failed schema validation.',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = CreateKeyBody.parse(req.body);
      const result = await apiKeysService.create({
        applicationId: id,
        name: body.name,
        scopes: body.scopes,
        ...(body.expiresAt !== undefined && { expiresAt: new Date(body.expiresAt) }),
      });
      void recordSecurityEvent({
        type: 'app.api_key.created',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { apiKeyId: result.apiKey.id, name: body.name, scopes: body.scopes },
      });
      return reply.status(201).send({
        success: true,
        data: {
          apiKey: result.apiKey,
          rawKey: result.rawKey,
          warning:
            'Store this rawKey now — it is shown exactly once and cannot be recovered. Treat it like a database password.',
        },
      });
    },
  );

  app.delete(
    '/:id/api-keys/:keyId',
    {
      schema: {
        tags: ['Tenant · API Keys'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke an API key',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, keyId: { type: 'string' } },
          required: ['id', 'keyId'],
        },
        response: {
          200: ok(ref('ApiKey'), 'The revoked key.'),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'API_KEY_NOT_FOUND — no key with that id on this Application; or ' + APP_WRITE_ERRORS[404],
          }),
        },
      },
    },
    async (req) => {
      const { id, keyId } = KeyIdParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const key = await apiKeysService.revoke(id, keyId);
      void recordSecurityEvent({
        type: 'app.api_key.revoked',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { apiKeyId: keyId },
      });
      return { success: true, data: key };
    },
  );

  // ---------- Plans ----------

  app.get(
    '/:id/plans',
    {
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }],
        summary: 'List Plans',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Each plan carries a `checkout` object saying whether a buyer would actually get a ' +
          'checkout for it. A plan created before this Application had provider credentials was ' +
          'never registered and has no price behind it, and connecting the provider afterwards ' +
          'does not repair it — `checkout.blockers` names the provider and the repair.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('Plan'), 'A page of Plans (active and inactive), newest first.'),
          ...errs({ 400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        plansService.listForApplication(id, true, { take, skip }),
        plansService.countForApplication(id, true),
      ]);
      // One credential lookup for the page, not one per plan. Evaluating the
      // blockers themselves is pure and calls neither the database nor the
      // provider.
      const readiness = await planCheckoutReadiness(id, items);
      const withReadiness = items.map((plan) => ({
        ...plan,
        checkout: readiness.get(plan.id) ?? { ready: true, blockers: [] },
      }));
      return { success: true, data: paged(withReadiness, total, take, skip) };
    },
  );

  app.post(
    '/:id/plans',
    {
      // Generic Idempotency-Key header support (scoped to the workspace).
      config: { idempotency: true },
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }],
        summary: 'Create a Plan',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['slug', 'name', 'amount'],
          properties: {
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            amount: { type: 'integer', minimum: 0, maximum: 2147483647 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            interval: { type: 'string', enum: ['MONTH', 'YEAR'] },
            kind: { type: 'string', enum: ['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT'] },
            licenseKind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
            licenseSeatsAllowed: { type: 'integer', minimum: 1, maximum: 2147483647 },
            licenseDurationDays: { type: 'integer', minimum: 1, maximum: 2147483647 },
            meterSlug: { type: 'string', minLength: 1, maxLength: 40 },
            pricePerUnitCents: { type: 'integer', minimum: 0, maximum: 2147483647 },
            creditsAmount: { type: 'integer', minimum: 1, maximum: 2147483647 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: ok(ref('Plan'), 'The created plan.'),
          ...errs({
            400:
              'PLAN_SLUG_INVALID — the slug is not URL-safe; or PLAN_AMOUNT_INVALID — `amount` ' +
              'is negative; or PLAN_LICENSE_KIND_REQUIRED / PLAN_LICENSE_DURATION_REQUIRED / ' +
              'PLAN_LICENSE_SEATS_REQUIRED — a LICENSE-kind plan is missing a required field; or ' +
              'PLAN_USAGE_CONFIG_REQUIRED / PLAN_USAGE_METER_UNKNOWN — a USAGE-kind plan is ' +
              'missing `meterSlug`/`pricePerUnitCents` or the meter does not exist; or ' +
              'PLAN_CREDITS_AMOUNT_REQUIRED — a CREDIT-kind plan is missing `creditsAmount`; or ' +
              'VALIDATION_ERROR — a field failed schema validation.',
            ...APP_BILLING_WRITE_ERRORS,
            409: 'PLAN_SLUG_TAKEN — another plan on this Application already uses that slug.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const body = CreatePlanBody.parse(req.body);
      const plan = await plansService.create({
        applicationId: id,
        slug: body.slug,
        name: body.name,
        amount: body.amount,
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.interval !== undefined && { interval: body.interval }),
        ...(body.kind !== undefined && { kind: body.kind }),
        ...(body.licenseKind !== undefined && { licenseKind: body.licenseKind }),
        ...(body.licenseSeatsAllowed !== undefined && { licenseSeatsAllowed: body.licenseSeatsAllowed }),
        ...(body.licenseDurationDays !== undefined && { licenseDurationDays: body.licenseDurationDays }),
        ...(body.meterSlug !== undefined && { meterSlug: body.meterSlug }),
        ...(body.pricePerUnitCents !== undefined && { pricePerUnitCents: body.pricePerUnitCents }),
        ...(body.creditsAmount !== undefined && { creditsAmount: body.creditsAmount }),
        ...(body.trialDays !== undefined && { trialDays: body.trialDays }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      // Pricing is money. A plan/coupon change with no trail means nobody can
      // answer "who moved this price, and when" during a billing dispute.
      void recordSecurityEvent({
        type: 'app.plan_created',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { slug: plan.slug, name: plan.name, amount: plan.amount, currency: plan.currency, interval: plan.interval, kind: plan.kind },
      });
      return reply.status(201).send({ success: true, data: plan });
    },
  );

  app.patch(
    '/:id/plans/:slug',
    {
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }],
        summary: 'Update a Plan',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.\n\n' +
          'Send any subset of the fields. `amount`, `currency` and `interval` are only accepted ' +
          'while the plan has **not** been registered with a payment provider — a provider price ' +
          'object is immutable once minted, so a registered plan answers `PLAN_PRICE_IMMUTABLE` ' +
          'and must be retired and replaced instead. This is the repair path for a plan whose ' +
          'registration was refused: correct it here, then `POST .../plans/{slug}/register`.\n\n' +
          '`active: true` is refused with `PLAN_NOT_REGISTERED_WITH_PROVIDER` for a plan that has ' +
          'no provider price — publishing one puts a dead checkout on the pricing page.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' } },
          required: ['id', 'slug'],
        },
        body: {
          type: 'object',
          properties: {
            active: { type: 'boolean' },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            amount: {
              type: 'integer',
              minimum: 0,
              description: 'Smallest currency unit. Unregistered plans only.',
            },
            currency: {
              type: 'string',
              minLength: 3,
              maxLength: 3,
              description: 'ISO 4217. Unregistered plans only.',
            },
            interval: {
              type: 'string',
              enum: ['MONTH', 'YEAR'],
              description: 'Unregistered plans only.',
            },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          200: ok(ref('Plan'), 'The plan, with `active` updated.'),
          ...errs({
            ...APP_BILLING_WRITE_ERRORS,
            404: 'PLAN_NOT_FOUND — no plan with that slug on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = PlanSlugParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const body = UpdatePlanBody.parse(req.body);
      const updated = await plansService.update(id, slug, {
        ...(body.active !== undefined && { active: body.active }),
        ...(body.name !== undefined && { name: body.name }),
        ...(body.amount !== undefined && { amount: body.amount }),
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.interval !== undefined && { interval: body.interval }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      void recordSecurityEvent({
        type: 'app.plan_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        // Money changed hands on the strength of these numbers — record which
        // fields moved, not just that "a plan was updated".
        metadata: { slug, changed: Object.keys(body).sort(), ...(body.active !== undefined && { active: body.active }) },
      });
      return { success: true, data: updated };
    },
  );

  app.post(
    '/:id/plans/:slug/register',
    {
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }],
        summary: 'Register (or re-register) a Plan with the payment provider',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.\n\n' +
          'Creates the Stripe Product + Price for a plan that has none and stores the price id ' +
          'on the plan. This is the repair for a plan whose registration was refused at create ' +
          'time — fix the credentials (or the plan, via PATCH) and call this; the plan goes back ' +
          'on sale on success, keeping its slug. Idempotent: a plan that is already registered ' +
          'is returned unchanged without calling the provider.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' } },
          required: ['id', 'slug'],
        },
        response: {
          200: ok(
            ref('Plan'),
            "The plan with its registrationStatus settled — REGISTERED if this attempt " +
              'succeeded, unchanged if it was already REGISTERED or NOT_REQUIRED.',
          ),
          ...errs({
            400: 'BILLING_CREDENTIALS_NOT_CONFIGURED — this Application has no stripe credentials configured.',
            ...APP_BILLING_WRITE_ERRORS,
            404:
              'PLAN_NOT_FOUND — no plan with that slug on this Application; or ' +
              APP_BILLING_WRITE_ERRORS[404],
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
            502:
              'BILLING_PROVIDER_ERROR — stripe rejected the registration attempt (only reachable ' +
              'while the plan was PENDING/FAILED). The plan\'s registrationStatus is now FAILED ' +
              "with the provider's message attached (`registrationError`), and it stays off sale.",
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = PlanSlugParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const plan = await plansService.registerWithProvider(id, slug);
      void recordSecurityEvent({
        type: 'app.plan_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { slug, registrationStatus: plan.registrationStatus, active: plan.active },
      });
      return { success: true, data: plan };
    },
  );

  // ---------- Plan entitlements (the benefit bundle) ----------

  app.get(
    '/:id/plans/:slug/entitlements',
    {
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }],
        summary: "List a plan's entitlements (the benefit bundle it grants)",
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' } },
          required: ['id', 'slug'],
        },
        response: {
          // Bounded by construction: entitlements are hand-added one at a time
          // in the plan editor, not a table that grows with end-user usage.
          200: okArray(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: ['FEATURE', 'CREDIT', 'LICENSE', 'USAGE'] },
                key: { type: 'string', nullable: true },
                valueType: { type: 'string', enum: ['BOOL', 'INT', 'STRING'], nullable: true },
                value: { type: 'string', nullable: true },
                quantity: { type: 'integer', nullable: true },
                creditsPerUnit: { type: 'integer', nullable: true },
                licenseKind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'], nullable: true },
                rollover: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'kind', 'rollover', 'createdAt'],
            },
            "The plan's entitlement bundle.",
          ),
          ...errs({
            ...APP_READ_ERRORS,
            404: 'PLAN_NOT_FOUND — no plan with that slug on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = PlanSlugParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const plan = await plansService.getBySlug(id, slug);
      const rows = await entitlementsService.listForPlan(plan.id);
      return {
        success: true,
        data: rows.map((e) => ({
          id: e.id,
          kind: e.kind,
          key: e.key,
          valueType: e.valueType,
          value: e.value,
          quantity: e.quantity,
          // Hand-written projection: a field omitted here is invisible to the
          // panel however correct the response schema and the service are.
          // creditsPerUnit was, so a priced usage allowance rendered as though
          // it were a hard cap.
          creditsPerUnit: e.creditsPerUnit,
          licenseKind: e.licenseKind,
          rollover: e.rollover,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  );

  app.put(
    '/:id/plans/:slug/entitlements',
    {
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }],
        summary: 'Add or update one entitlement on a plan (upsert by kind+key)',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' } },
          required: ['id', 'slug'],
        },
        body: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['FEATURE', 'CREDIT', 'LICENSE', 'USAGE'] },
            key: { type: 'string', maxLength: 80 },
            valueType: { type: 'string', enum: ['BOOL', 'INT', 'STRING'] },
            value: { type: 'string', maxLength: 200 },
            quantity: { type: 'integer', minimum: 0, maximum: 2147483647 },
            // USAGE only: credits charged per unit past `quantity`. Omitted
            // leaves the quota a hard cap, which is the prior behaviour.
            creditsPerUnit: { type: 'integer', minimum: 0, maximum: 2147483647 },
            licenseKind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
            rollover: { type: 'boolean' },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: ['FEATURE', 'CREDIT', 'LICENSE', 'USAGE'] },
                key: { type: 'string', nullable: true },
              },
              required: ['id', 'kind'],
            },
            'The upserted entitlement (id/kind/key).',
          ),
          ...errs({
            400: 'PLAN_ENTITLEMENT_INVALID — the field combination required for this `kind` is incomplete or invalid.',
            ...APP_BILLING_WRITE_ERRORS,
            404: 'PLAN_NOT_FOUND — no plan with that slug on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = PlanSlugParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const plan = await plansService.getBySlug(id, slug);
      const body = z
        .object({
          kind: z.enum(['FEATURE', 'CREDIT', 'LICENSE', 'USAGE']),
          key: z.string().max(80).optional(),
          valueType: z.enum(['BOOL', 'INT', 'STRING']).optional(),
          value: z.string().max(200).optional(),
          // Zero, not positive: a USAGE entitlement priced per unit may include
          // no free units at all. The service refuses a zero that carries no
          // price, since that grants nothing and costs nothing.
          quantity: z.number().int().min(0).max(2_147_483_647).optional(),
          // Zero is meaningful: "no free units, charge from the first one".
          creditsPerUnit: z.number().int().min(0).max(2_147_483_647).optional(),
          licenseKind: z.enum(['PERPETUAL', 'TIMED', 'SEATS']).optional(),
          rollover: z.boolean().optional(),
        })
        .parse(req.body);
      const e = await entitlementsService.upsert({
        planId: plan.id,
        kind: body.kind,
        ...(body.key !== undefined && { key: body.key }),
        ...(body.valueType !== undefined && { valueType: body.valueType }),
        ...(body.value !== undefined && { value: body.value }),
        ...(body.quantity !== undefined && { quantity: body.quantity }),
        ...(body.creditsPerUnit !== undefined && { creditsPerUnit: body.creditsPerUnit }),
        ...(body.licenseKind !== undefined && { licenseKind: body.licenseKind }),
        ...(body.rollover !== undefined && { rollover: body.rollover }),
      });
      void recordSecurityEvent({
        type: 'app.plan_entitlement_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { planSlug: slug, entitlementId: e.id, kind: e.kind, key: e.key },
      });
      return { success: true, data: { id: e.id, kind: e.kind, key: e.key } };
    },
  );

  app.delete(
    '/:id/plans/:slug/entitlements/:entId',
    {
      schema: {
        tags: ['Tenant · Plans'],
        security: [{ tenantSession: [] }],
        summary: 'Remove an entitlement from a plan',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' }, entId: { type: 'string' } },
          required: ['id', 'slug', 'entId'],
        },
        response: {
          200: ok(
            { type: 'object', properties: { removed: { type: 'boolean', enum: [true] } }, required: ['removed'] },
            'Confirmation of removal.',
          ),
          ...errs({
            ...APP_BILLING_WRITE_ERRORS,
            404:
              'PLAN_NOT_FOUND — no plan with that slug on this Application; or ' +
              'PLAN_ENTITLEMENT_NOT_FOUND — no entitlement with that id on this plan.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), slug: z.string().min(1), entId: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'billing-write');
      const plan = await plansService.getBySlug(params.id, params.slug);
      const data = await entitlementsService.remove(plan.id, params.entId);
      void recordSecurityEvent({
        type: 'app.plan_entitlement_removed',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: params.id,
        ...requestContext(req),
        metadata: { planSlug: params.slug, entitlementId: params.entId },
      });
      return { success: true, data };
    },
  );

  // ---------- Coupons ----------

  app.get(
    '/:id/coupons',
    {
      schema: {
        tags: ['Tenant · Coupons'],
        security: [{ tenantSession: [] }],
        summary: 'List Coupons (with redemption stats)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Each coupon carries `redemptionCount` and `totalDiscountIssued` (smallest ' +
          'currency unit) aggregated from the redemptions table.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(
            {
              allOf: [
                ref('Coupon'),
                {
                  type: 'object',
                  properties: {
                    redemptionCount: { type: 'integer' },
                    totalDiscountIssued: {
                      type: 'integer',
                      description: 'Smallest currency unit, summed across redemptions.',
                    },
                  },
                  required: ['redemptionCount', 'totalDiscountIssued'],
                },
              ],
            },
            'A page of coupons (active and inactive), each with redemption stats.',
          ),
          ...errs({ 400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        couponsService.listWithStats(id, true, { take, skip }),
        couponsService.count(id, true),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/coupons',
    {
      // Generic Idempotency-Key header support (scoped to the workspace).
      config: { idempotency: true },
      schema: {
        tags: ['Tenant · Coupons'],
        security: [{ tenantSession: [] }],
        summary: 'Create a Coupon',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['code', 'discountType', 'amountOff'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 40 },
            discountType: { type: 'string', enum: ['PERCENT', 'AMOUNT'] },
            amountOff: { type: 'integer', minimum: 0, maximum: 2147483647 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            planSlugs: { type: 'array', items: { type: 'string' } },
            startsAt: { type: 'string', format: 'date-time' },
            endsAt: { type: 'string', format: 'date-time' },
            maxRedemptions: { type: 'integer', minimum: 1, maximum: 2147483647 },
            maxRedemptionsPerUser: { type: 'integer', minimum: 1, maximum: 2147483647 },
          },
        },
        response: {
          201: ok(ref('Coupon'), 'The created coupon.'),
          ...errs({
            400:
              'COUPON_CODE_INVALID — the code is not 1-40 alphanumerics/underscores/hyphens; or ' +
              'COUPON_AMOUNT_INVALID — `amountOff` is negative, or a PERCENT discount exceeds ' +
              '10000 basis points (100%); or VALIDATION_ERROR — a field failed schema validation.',
            ...APP_BILLING_WRITE_ERRORS,
            409: 'COUPON_CODE_TAKEN — another coupon on this Application already uses that code.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const body = CreateCouponBody.parse(req.body);
      const coupon = await couponsService.create({
        applicationId: id,
        code: body.code,
        discountType: body.discountType as CouponDiscountType,
        amountOff: body.amountOff,
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.planSlugs !== undefined && { planSlugs: body.planSlugs }),
        ...(body.startsAt !== undefined && { startsAt: new Date(body.startsAt) }),
        ...(body.endsAt !== undefined && { endsAt: new Date(body.endsAt) }),
        ...(body.maxRedemptions !== undefined && { maxRedemptions: body.maxRedemptions }),
        ...(body.maxRedemptionsPerUser !== undefined && {
          maxRedemptionsPerUser: body.maxRedemptionsPerUser,
        }),
      });
      void recordSecurityEvent({
        type: 'app.coupon_created',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { code: coupon.code, discountType: coupon.discountType, amountOff: coupon.amountOff, currency: coupon.currency },
      });
      return reply.status(201).send({ success: true, data: coupon });
    },
  );

  app.patch(
    '/:id/coupons/:code',
    {
      schema: {
        tags: ['Tenant · Coupons'],
        security: [{ tenantSession: [] }],
        summary: 'Toggle a Coupon\'s active flag',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, code: { type: 'string' } },
          required: ['id', 'code'],
        },
        body: {
          type: 'object',
          required: ['active'],
          properties: { active: { type: 'boolean' } },
        },
        response: {
          200: ok(ref('Coupon'), 'The coupon, with `active` updated.'),
          ...errs({
            ...APP_BILLING_WRITE_ERRORS,
            404: 'COUPON_NOT_FOUND — no coupon with that code on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, code } = CouponCodeParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const body = CouponActiveBody.parse(req.body);
      const updated = await couponsService.setActive(id, code, body.active);
      void recordSecurityEvent({
        type: 'app.coupon_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { code, active: body.active },
      });
      return { success: true, data: updated };
    },
  );

  // ---------- Billing credentials (BYO, per-provider) ----------
  //
  // Multi-provider: tenants can configure stripe + paypal + razorpay
  // concurrently. Each provider has its own row in `billing_credentials`,
  // its own routing rules (`countries[]`, `priority`), and its own
  // enable/disable flag.
  //
  // GET  /:id/billing-credentials                  → list all configured providers (no secrets)
  // PUT  /:id/billing-credentials/:provider        → upsert one provider's creds + routing
  // PATCH /:id/billing-credentials/:provider       → toggle enabled / change routing only
  // DELETE /:id/billing-credentials/:provider      → remove the provider entirely

  // Tenant discovery endpoint (P4): EVERY registered provider module —
  // configured for this app or not — with the metadata the panel needs to
  // render the provider list and autogenerate credential forms. Credential
  // FIELD SCHEMAS only, never stored values (`providerDescriptor` projects
  // the module; secrets are structurally absent). Per-app configured status
  // rides along so one call drives the whole billing page.
  app.get(
    '/:id/billing/providers',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'Discover all registered billing provider modules (+ per-app status)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'One entry per REGISTERED provider module (in registry order), whether or not this ' +
          'Application has configured it: display metadata (label, docs URL, default countries, ' +
          'priority), capabilities, and the credential field schema the panel renders forms from. ' +
          '`status` is null until the provider is configured for this Application. ' +
          'Never returns credential values — those are write-only.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                providers: {
                  type: 'array',
                  description: 'Bounded — one entry per registered provider module (currently 3).',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      label: { type: 'string' },
                      docsUrl: { type: 'string', format: 'uri' },
                      defaultCountries: { type: 'array', items: { type: 'string' } },
                      priority: { type: 'integer' },
                      capabilities: {
                        type: 'object',
                        description: 'Feature flags this provider module supports.',
                        properties: {
                          oneTime: { type: 'boolean' },
                          captureStep: { type: 'boolean' },
                          autoWebhookRegister: { type: 'boolean' },
                          periodRotationEvents: { type: 'boolean' },
                          onlineVerify: { type: 'boolean' },
                        },
                        additionalProperties: true,
                      },
                      credentialFields: {
                        type: 'array',
                        description: 'Field schema the panel renders the credential form from. Never a stored value.',
                        items: {
                          type: 'object',
                          properties: {
                            key: { type: 'string' },
                            label: { type: 'string' },
                            secret: { type: 'boolean' },
                            optional: { type: 'boolean' },
                            placeholder: { type: 'string' },
                            help: { type: 'string' },
                            pattern: {
                              type: 'object',
                              properties: { message: { type: 'string' } },
                              required: ['message'],
                            },
                          },
                          required: ['key', 'label', 'secret', 'optional'],
                        },
                      },
                      configured: { type: 'boolean' },
                      status: {
                        nullable: true,
                        type: 'object',
                        description: 'null until this provider is configured for this Application.',
                        properties: {
                          enabled: { type: 'boolean' },
                          mode: { type: 'string', enum: ['test', 'live'] },
                          countries: { type: 'array', items: { type: 'string' } },
                          priority: { type: 'integer' },
                          webhookConfigured: { type: 'boolean' },
                        },
                        required: ['enabled', 'mode', 'countries', 'priority', 'webhookConfigured'],
                      },
                    },
                    required: [
                      'name', 'label', 'docsUrl', 'defaultCountries', 'priority',
                      'capabilities', 'credentialFields', 'configured', 'status',
                    ],
                  },
                },
              },
              required: ['providers'],
            },
            'Every registered billing provider module, with this Application\'s per-provider status.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const statuses = await billingCredentialsService.list(id);
      const byProvider = new Map(statuses.map((s) => [s.provider as string, s]));
      return {
        success: true,
        data: {
          providers: registryNames.map((name) => {
            const row = byProvider.get(name);
            return {
              ...providerDescriptor(getModule(name)!),
              configured: row !== undefined,
              status:
                row === undefined
                  ? null
                  : {
                      enabled: row.enabled,
                      mode: row.mode,
                      countries: row.countries,
                      priority: row.priority,
                      webhookConfigured: row.webhookConfigured,
                    },
            };
          }),
        },
      };
    },
  );

  app.get(
    '/:id/billing-credentials',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'List all billing providers configured for this Application',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Returns one entry per configured provider with its enabled flag, country list, and priority. ' +
          'Never returns the credentials themselves — those are write-only.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: okArray(
            {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] },
                configured: { type: 'boolean', enum: [true] },
                enabled: { type: 'boolean' },
                mode: { type: 'string', enum: ['test', 'live'] },
                countries: { type: 'array', items: { type: 'string' } },
                priority: { type: 'integer' },
                webhookConfigured: { type: 'boolean' },
              },
              required: ['provider', 'configured', 'enabled', 'mode', 'countries', 'priority', 'webhookConfigured'],
            },
            // Bounded by construction: at most one row per registered provider (3 today).
            'Providers configured for this Application. Never includes credential values.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const list = await billingCredentialsService.list(id);
      return { success: true, data: list };
    },
  );

  app.put(
    '/:id/billing-credentials/:provider',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'Set or rotate BYO credentials for one provider',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Body shape depends on `provider` (fields come from the provider module registry):\n' +
          registryNames
            .map(
              (n) =>
                `  ${n} → { data: { ${getModule(n)!
                  .credentialSchema.map((f) => f.key)
                  .join(', ')} }, countries?, priority?, enabled? }`,
            )
            .join('\n') +
          '\n\n' +
          'Credentials are AES-256-GCM encrypted at rest. There is no GET that returns plaintext.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            provider: { type: 'string', enum: registryNames },
          },
          required: ['id', 'provider'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                configured: { type: 'boolean', enum: [true] },
                provider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] },
              },
              required: ['configured', 'provider'],
            },
            'Confirmation — credential values are never echoed back.',
          ),
          ...errs({
            400:
              'BILLING_CREDENTIALS_INVALID — a required field is missing or fails the ' +
              "provider's pattern rule; or BILLING_CREDENTIALS_MODE_CONTRADICTED — the key " +
              'material states a mode that contradicts the submitted `mode`; or ' +
              'VALIDATION_ERROR — a field failed schema validation.',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string(), provider: providerNameSchema })
        .parse(req.params);
      const provider = params.provider as BillingProviderName;
      await ensureAppAccess(req, params.id, 'write');

      // Generic body validation (P3): the `data` shape derives from the
      // module's credentialSchema; routing fields are provider-independent.
      // Pattern rules (sk_/whsec_/rzp_ prefixes) are enforced by the
      // credentials service, which raises BILLING_CREDENTIALS_INVALID.
      const module = getModule(params.provider)!; // providerNameSchema ⇒ registered
      const body = z
        .object({
          data: credentialDataSchema(module),
          countries: z.array(z.string().length(2)).optional(),
          priority: z.number().int().min(0).max(1000).optional(),
          enabled: z.boolean().optional(),
          mode: z.enum(['test', 'live']).optional(),
        })
        .parse(req.body);
      const opts: Parameters<typeof billingCredentialsService.upsertCredentials>[3] = {};
      if (body.countries !== undefined) opts.countries = body.countries;
      if (body.priority !== undefined) opts.priority = body.priority;
      if (body.enabled !== undefined) opts.enabled = body.enabled;
      if (body.mode !== undefined) opts.mode = body.mode;
      await billingCredentialsService.upsertCredentials(params.id, provider, body.data, opts);

      // Audit the credential mutation — provider secrets are highly sensitive.
      // Never log the secret material itself, only that it was set/rotated.
      void recordSecurityEvent({
        type: 'app.billing_credentials_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: params.id,
        ...requestContext(req),
        metadata: { provider: params.provider, action: 'upsert' },
      });

      return { success: true, data: { configured: true, provider: params.provider } };
    },
  );

  app.patch(
    '/:id/billing-credentials/:provider',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'Update routing or enabled flag for one provider (no secret rotation)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            provider: { type: 'string', enum: registryNames },
          },
          required: ['id', 'provider'],
        },
        body: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            countries: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 2 } },
            priority: { type: 'integer', minimum: 0, maximum: 1000 },
            mode: { type: 'string', enum: ['test', 'live'] },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { provider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] } },
              required: ['provider'],
            },
            'Confirmation.',
          ),
          ...errs({
            400:
              'BILLING_CREDENTIALS_MODE_CONTRADICTED — the stored key material states a mode ' +
              'that contradicts the submitted `mode`; or VALIDATION_ERROR — a field failed schema validation.',
            ...APP_WRITE_ERRORS,
            404:
              APP_WRITE_ERRORS[404] +
              ' Or BILLING_CREDENTIALS_NOT_CONFIGURED — `mode` was sent but no credentials are stored for this provider yet.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string(), provider: providerNameSchema })
        .parse(req.params);
      const provider = params.provider as BillingProviderName;
      await ensureAppAccess(req, params.id, 'write');
      const body = z
        .object({
          enabled: z.boolean().optional(),
          countries: z.array(z.string().length(2)).optional(),
          priority: z.number().int().min(0).max(1000).optional(),
          mode: z.enum(['test', 'live']).optional(),
        })
        .parse(req.body);
      if (body.enabled !== undefined) {
        await billingCredentialsService.setEnabled(params.id, provider, body.enabled);
      }
      if (body.mode !== undefined) {
        await billingCredentialsService.setMode(params.id, provider, body.mode);
      }
      if (body.countries !== undefined || body.priority !== undefined) {
        await billingCredentialsService.setRouting(
          params.id,
          provider,
          body.countries ?? [],
          body.priority ?? 100,
        );
      }
      void recordSecurityEvent({
        type: 'app.billing_credentials_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: params.id,
        ...requestContext(req),
        metadata: { provider: params.provider, action: 'patch', changed: Object.keys(body) },
      });
      return { success: true, data: { provider: params.provider } };
    },
  );

  app.delete(
    '/:id/billing-credentials/:provider',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'Remove credentials for one provider entirely',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            provider: { type: 'string', enum: registryNames },
          },
          required: ['id', 'provider'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                configured: { type: 'boolean', enum: [false] },
                provider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] },
              },
              required: ['configured', 'provider'],
            },
            'Confirmation.',
          ),
          // NOTE: `billingCredentialsService.remove` is an unconditional prisma.delete — deleting
          // a provider with no stored row throws an uncaught Prisma P2025, which the global error
          // handler turns into a generic 500, not a 404. Not declared here for that reason; see
          // the handler/schema contradictions note in the final report.
          ...errs(APP_WRITE_ERRORS),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string(), provider: providerNameSchema })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      await billingCredentialsService.remove(params.id, params.provider as BillingProviderName);
      void recordSecurityEvent({
        type: 'app.billing_credentials_deleted',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: params.id,
        ...requestContext(req),
        metadata: { provider: params.provider, action: 'delete' },
      });
      return { success: true, data: { configured: false, provider: params.provider } };
    },
  );

  app.post(
    '/:id/billing-credentials/:provider/register-webhook',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'Auto-configure the provider webhook via its API (no manual paste)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          "Creates the webhook endpoint at this Application's Rekey URL and stores the " +
          'returned signing secret (Stripe) / webhook id (PayPal) into the credentials. ' +
          'Save the provider credentials first. Razorpay is not supported — configure it manually.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            provider: { type: 'string', enum: registryNames },
          },
          required: ['id', 'provider'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] },
                webhookConfigured: { type: 'boolean' },
                url: { type: 'string', format: 'uri' },
              },
              required: ['provider', 'webhookConfigured', 'url'],
            },
            'The registered webhook endpoint.',
          ),
          ...errs({
            400:
              'BILLING_WEBHOOK_BASE_NOT_PUBLIC — PUBLIC_WEBHOOK_BASE_URL/API_URL is not a ' +
              'public URL; or BILLING_CREDENTIALS_NOT_CONFIGURED — save provider credentials ' +
              'first; or BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED — this provider (Razorpay) has ' +
              'no auto-register API.',
            ...APP_WRITE_ERRORS,
            502: 'BILLING_WEBHOOK_REGISTRATION_FAILED — the provider API rejected the registration call.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string(), provider: providerNameSchema })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const application = await applicationsService.get(params.id, {
        tenantId: req.tenantId!,
      });
      const result = await registerProviderWebhook(
        params.id,
        params.provider as BillingProviderName,
        application.slug,
      );
      return { success: true, data: result };
    },
  );

  app.get(
    '/:id/billing-credentials/webhook-events',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'List recent INBOUND provider webhook events (Stripe/PayPal/Razorpay)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'The events Rekey received from the billing provider (subscription activated, ' +
          'payment captured, etc.). Filter by `?provider=`. This is the inbound log — distinct ' +
          "from outbound webhook deliveries (this Application's own /webhooks endpoints).",
        querystring: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: registryNames },
            ...paginationJsonSchema,
          },
        },
        response: {
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                provider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] },
                providerEventId: { type: 'string' },
                eventType: { type: 'string' },
                receivedAt: { type: 'string', format: 'date-time' },
                processedAt: { type: 'string', format: 'date-time', nullable: true },
                processingError: { type: 'string', nullable: true },
                status: { type: 'string', enum: ['error', 'processed', 'received'] },
              },
              required: ['id', 'provider', 'providerEventId', 'eventType', 'receivedAt', 'status'],
            },
            'A page of inbound provider webhook events, newest first.',
          ),
          ...errs({ 400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1) }).parse(req.params);
      const query = z
        .object({ provider: providerNameSchema.optional() })
        .merge(PaginationQuery)
        .parse(req.query);
      await ensureAppAccess(req, params.id, 'read');
      const { take, skip } = parsePagination(query);
      const where = {
        applicationId: params.id,
        ...(query.provider ? { provider: query.provider } : {}),
      };
      const [events, total] = await Promise.all([
        prisma.webhookEvent.findMany({
          where,
          select: {
            id: true,
            provider: true,
            providerEventId: true,
            eventType: true,
            receivedAt: true,
            processedAt: true,
            processingError: true,
          },
          orderBy: { receivedAt: 'desc' },
          take,
          skip,
        }),
        prisma.webhookEvent.count({ where }),
      ]);
      return {
        success: true,
        data: paged(
          events.map((e) => ({
            ...e,
            // processed cleanly → ok; recorded but errored → error; not yet processed → received.
            status: e.processingError ? 'error' : e.processedAt ? 'processed' : 'received',
            receivedAt: e.receivedAt.toISOString(),
            processedAt: e.processedAt?.toISOString() ?? null,
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  // ---------- Billing stats (operator revenue dashboard) ----------

  app.get(
    '/:id/billing/stats',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'Revenue / subscription stats for this Application (Billing Overview tiles)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Subscription counters (active, past-due, canceled/new in the last 30 days), MRR ' +
          '(ACTIVE recurring SUBSCRIPTION plans, yearly normalized to monthly), 30-day payment ' +
          'volume + success/failure counts, and a 12-month UTC monthly revenue series. ' +
          'All amounts are in the smallest currency unit.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(ref('BillingStats'), 'Revenue and subscription stats for this Application.'),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await billingStatsService.forApplication(id) };
    },
  );

  // ---------- Payments (operator billing view) ----------

  app.get(
    '/:id/payments',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'List payments for this Application (newest first)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Operator view of every Payment row — subscription invoices and one-time charges. ' +
          'Filter by `status` and a `from`/`to` createdAt window. Joined with the paying ' +
          "end-user's email where the payment is attributable to one. " +
          'Sort with `?sort=createdAt|amount|status&order=asc|desc` (default createdAt desc).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            sort: { type: 'string', enum: ['createdAt', 'amount', 'status'] },
            order: { type: 'string', enum: ['asc', 'desc'] },
            ...paginationJsonSchema,
          },
        },
        response: {
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                endUserId: { type: 'string', nullable: true },
                subscriptionId: { type: 'string', nullable: true },
                amount: { type: 'integer' },
                currency: { type: 'string' },
                status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] },
                providerPaymentId: { type: 'string', nullable: true },
                description: { type: 'string', nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
                endUserEmail: {
                  type: 'string',
                  nullable: true,
                  description: 'Joined from EndUser; null when the payment is not attributable to one.',
                },
              },
              required: ['id', 'amount', 'currency', 'status', 'createdAt', 'endUserEmail'],
            },
            'A page of payments, sorted per `?sort`/`?order` (default createdAt desc).',
          ),
          ...errs({ 400: 'VALIDATION_ERROR — `limit`/`offset` out of range, or an invalid `status`/`sort`/`order`.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const q = z
        .object({
          status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          sort: z.enum(['createdAt', 'amount', 'status']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
        })
        .merge(PaginationQuery)
        .parse(req.query);
      const { take, skip } = parsePagination(q); // default 50, max 100
      const order = q.order ?? 'desc';
      const primaryOrder =
        q.sort === 'amount'
          ? { amount: order }
          : q.sort === 'status'
            ? { status: order }
            : { createdAt: order };
      const where = {
        applicationId: id,
        ...(q.status && { status: q.status }),
        ...((q.from || q.to) && {
          createdAt: {
            ...(q.from && { gte: q.from }),
            ...(q.to && { lte: q.to }),
          },
        }),
      };
      const [payments, total] = await Promise.all([
        prisma.payment.findMany({
          where,
          select: {
            id: true,
            endUserId: true,
            subscriptionId: true,
            amount: true,
            currency: true,
            status: true,
            providerPaymentId: true,
            description: true,
            createdAt: true,
          },
          // Stable secondary order by id so pages never overlap/skip when many
          // rows share the same sort value (e.g. equal amounts).
          orderBy: [primaryOrder, { id: 'desc' }],
          take,
          skip,
        }),
        prisma.payment.count({ where }),
      ]);
      // Payment has no Prisma relation to EndUser (endUserId is a plain
      // column) — join the email with a second bounded query.
      const userIds = [...new Set(payments.map((p) => p.endUserId).filter((v): v is string => v !== null))];
      const users = userIds.length
        ? await prisma.endUser.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true },
          })
        : [];
      const emailById = new Map(users.map((u) => [u.id, u.email]));
      return {
        success: true,
        data: paged(
          payments.map((p) => ({
            ...p,
            endUserEmail: p.endUserId ? (emailById.get(p.endUserId) ?? null) : null,
            createdAt: p.createdAt.toISOString(),
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  // ---------- Dunning cases (failed-payment recovery) ----------

  app.get(
    '/:id/dunning',
    {
      schema: {
        tags: ['Tenant · Billing'],
        security: [{ tenantSession: [] }],
        summary: 'List dunning cases for this Application (newest first)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Failed-payment recovery cases. A case opens when a subscription goes PAST_DUE, ' +
          'sends reminder emails on day 0/3/7, and exhausts on day 14 (subscription canceled). ' +
          'The provider drives the actual card retries — see docs/billing.md → Dunning. ' +
          'Filter with `?status=`; sort with `?sort=openedAt|nextActionAt|status&order=asc|desc` ' +
          '(default openedAt desc).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['OPEN', 'RECOVERED', 'EXHAUSTED', 'CANCELED'] },
            sort: { type: 'string', enum: ['openedAt', 'nextActionAt', 'status'] },
            order: { type: 'string', enum: ['asc', 'desc'] },
            ...paginationJsonSchema,
          },
        },
        response: {
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                subscriptionId: { type: 'string' },
                endUserId: { type: 'string', nullable: true },
                endUserEmail: { type: 'string', nullable: true },
                organizationId: { type: 'string', nullable: true },
                status: { type: 'string', enum: ['OPEN', 'RECOVERED', 'EXHAUSTED', 'CANCELED'] },
                planSlug: { type: 'string' },
                planName: { type: 'string' },
                failedAttempts: { type: 'integer' },
                remindersSent: { type: 'integer' },
                lastFailureAt: { type: 'string', format: 'date-time', nullable: true },
                nextActionAt: { type: 'string', format: 'date-time', nullable: true },
                openedAt: { type: 'string', format: 'date-time' },
                closedAt: { type: 'string', format: 'date-time', nullable: true },
              },
              required: ['id', 'subscriptionId', 'status', 'planSlug', 'planName', 'failedAttempts', 'remindersSent', 'openedAt'],
            },
            'A page of dunning cases, sorted per `?sort`/`?order` (default openedAt desc).',
          ),
          ...errs({ 400: 'VALIDATION_ERROR — `limit`/`offset` out of range, or an invalid `status`/`sort`/`order`.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const q = z
        .object({
          status: z.enum(['OPEN', 'RECOVERED', 'EXHAUSTED', 'CANCELED']).optional(),
          sort: z.enum(['openedAt', 'nextActionAt', 'status']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
        })
        .merge(PaginationQuery)
        .parse(req.query);
      const { take, skip } = parsePagination(q);
      const order = q.order ?? 'desc';
      const primaryOrder =
        q.sort === 'nextActionAt'
          ? { nextActionAt: order }
          : q.sort === 'status'
            ? { status: order }
            : { openedAt: order };
      const where = { applicationId: id, ...(q.status && { status: q.status }) };
      const [cases, total] = await Promise.all([
        prisma.dunningCase.findMany({
          where,
          include: { subscription: { select: { plan: { select: { slug: true, name: true } } } } },
          // Stable secondary order by id so pages never overlap/skip.
          orderBy: [primaryOrder, { id: 'desc' }],
          take,
          skip,
        }),
        prisma.dunningCase.count({ where }),
      ]);
      // DunningCase.endUserId is a plain column (like Payment) — join the
      // emails with a second bounded query.
      const userIds = [
        ...new Set(cases.map((c) => c.endUserId).filter((v): v is string => v !== null)),
      ];
      const users = userIds.length
        ? await prisma.endUser.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true },
          })
        : [];
      const emailById = new Map(users.map((u) => [u.id, u.email]));
      return {
        success: true,
        data: paged(
          cases.map((c) => ({
            id: c.id,
            subscriptionId: c.subscriptionId,
            endUserId: c.endUserId,
            endUserEmail: c.endUserId ? (emailById.get(c.endUserId) ?? null) : null,
            organizationId: c.organizationId,
            status: c.status,
            planSlug: c.subscription.plan.slug,
            planName: c.subscription.plan.name,
            failedAttempts: c.failedAttempts,
            remindersSent: c.remindersSent,
            lastFailureAt: c.lastFailureAt?.toISOString() ?? null,
            nextActionAt: c.nextActionAt?.toISOString() ?? null,
            openedAt: c.openedAt.toISOString(),
            closedAt: c.closedAt?.toISOString() ?? null,
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  // ---------- OAuth provider config ----------

  app.put(
    '/:id/oauth-config/:provider',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [{ tenantSession: [] }],
        summary: 'Set or rotate an OAuth provider config (clientId + clientSecret + redirectUri)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'clientSecret is encrypted at rest. Public bits (clientId, redirectUri, scopes, issuerUrl) live in `oauthConfig`. ' +
          'Built-in providers: google, github, microsoft, discord, gitlab, slack, oidc. ' +
          'For `oidc`, also pass `issuerUrl` (e.g. https://login.example.com) — endpoints are auto-discovered.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, provider: { type: 'string' } },
          required: ['id', 'provider'],
        },
        body: {
          type: 'object',
          required: ['clientId', 'clientSecret', 'redirectUri'],
          properties: {
            clientId: { type: 'string', minLength: 1, maxLength: 256 },
            clientSecret: { type: 'string', minLength: 1, maxLength: 1024 },
            redirectUri: { type: 'string', format: 'uri' },
            scopes: { type: 'array', items: { type: 'string' } },
            issuerUrl: { type: 'string', format: 'uri' },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['google', 'github', 'microsoft', 'discord', 'gitlab', 'slack', 'oidc'] },
                configured: { type: 'boolean', enum: [true] },
              },
              required: ['provider', 'configured'],
            },
            'Confirmation — clientSecret is never echoed back.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `provider` unsupported, or a field failed schema validation.',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const SUPPORTED = ['google', 'github', 'microsoft', 'discord', 'gitlab', 'slack', 'oidc'] as const;
      const { id, provider } = z
        .object({ id: z.string().min(1), provider: z.enum(SUPPORTED) })
        .parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          clientId: z.string().min(1).max(256),
          clientSecret: z.string().min(1).max(1024),
          redirectUri: z.string().url(),
          scopes: z.array(z.string()).optional(),
          issuerUrl: z.string().url().optional(),
        })
        .parse(req.body);
      // OIDC requires an issuerUrl; everything else ignores it.
      if (provider === 'oidc' && !body.issuerUrl) {
        throw new Error('OIDC provider requires `issuerUrl`.');
      }
      await oauthService.setProviderConfig({
        applicationId: id,
        providerName: provider,
        public: {
          clientId: body.clientId,
          redirectUri: body.redirectUri,
          ...(body.scopes !== undefined && { scopes: body.scopes }),
          ...(body.issuerUrl !== undefined && { issuerUrl: body.issuerUrl }),
        },
        clientSecret: body.clientSecret,
      });
      return { success: true, data: { provider, configured: true } };
    },
  );

  app.delete(
    '/:id/oauth-config/:provider',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [{ tenantSession: [] }],
        summary: 'Remove an OAuth provider config',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, provider: { type: 'string' } },
          required: ['id', 'provider'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['google', 'github', 'microsoft', 'discord', 'gitlab', 'slack', 'oidc'] },
                configured: { type: 'boolean', enum: [false] },
              },
              required: ['provider', 'configured'],
            },
            'Confirmation. Idempotent — removing an already-unconfigured provider still 200s.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `provider` unsupported.',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const SUPPORTED = ['google', 'github', 'microsoft', 'discord', 'gitlab', 'slack', 'oidc'] as const;
      const { id, provider } = z
        .object({ id: z.string().min(1), provider: z.enum(SUPPORTED) })
        .parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await oauthService.removeProviderConfig({ applicationId: id, providerName: provider });
      return { success: true, data: { provider, configured: false } };
    },
  );

  // ---------- End-users (read-only listing for picker UI) ----------

  app.get(
    '/:id/end-users',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'List recent end-users (for license issuance pickers etc.)',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Sort with `?sort=createdAt|email&order=asc|desc` (default createdAt desc).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', maxLength: 254 },
            emailVerified: { type: 'boolean' },
            subscriptionStatus: {
              type: 'string',
              enum: ['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'],
            },
            sort: { type: 'string', enum: ['createdAt', 'email'] },
            order: { type: 'string', enum: ['asc', 'desc'] },
            ...paginationJsonSchema,
          },
        },
        response: {
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string', format: 'email' },
                emailVerified: { type: 'boolean' },
                role: { type: 'string' },
                metadata: { type: 'object', nullable: true, additionalProperties: true },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'email', 'emailVerified', 'role', 'createdAt'],
            },
            'A page of end-users, sorted per `?sort`/`?order` (default createdAt desc, default page size 25).',
          ),
          ...errs({ 400: 'VALIDATION_ERROR — `limit`/`offset` out of range, or an invalid `sort`/`order`/`subscriptionStatus`.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const q = z
        .object({
          search: z.string().max(254).optional(),
          // Fastify's Ajv coerces "true"/"false" query strings to booleans
          // via the querystring schema above before zod sees them.
          emailVerified: z.boolean().optional(),
          subscriptionStatus: z
            .enum(['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'])
            .optional(),
          sort: z.enum(['createdAt', 'email']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
        })
        .merge(PaginationQuery)
        .parse(req.query);
      const { take, skip } = parsePagination(q, 25);
      const order = q.order ?? 'desc';
      // The endpoint the functional audit caught truncating: 36 rows in the
      // database, 25 returned, and nothing in the response saying so. `total`
      // and `hasMore` are the fix.
      const where = {
        applicationId: id,
        ...(q.search && { email: { contains: q.search.toLowerCase() } }),
        ...(q.emailVerified !== undefined && { emailVerified: q.emailVerified }),
        ...(q.subscriptionStatus && {
          subscriptions: { some: { status: q.subscriptionStatus } },
        }),
      };
      const [users, total] = await Promise.all([
        prisma.endUser.findMany({
          where,
          // Stable secondary order by id keeps pagination consistent on ties.
          orderBy: [q.sort === 'email' ? { email: order } : { createdAt: order }, { id: 'desc' }],
          take,
          skip,
          select: {
            id: true, email: true, emailVerified: true, role: true, metadata: true, createdAt: true,
          },
        }),
        prisma.endUser.count({ where }),
      ]);
      return { success: true, data: paged(users, total, take, skip) };
    },
  );

  // ---------- End-users: manual create / edit / delete ----------
  //
  // Sign-up via the SDK is the primary path; these endpoints exist for
  // operators to seed users (data migrations, support flows, invitations
  // outside the app). Same Application scoping, same uniqueness invariants
  // (email is unique per Application).

  app.post(
    '/:id/end-users',
    {
      // Generic Idempotency-Key header support (scoped to the workspace).
      config: { idempotency: true },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Create an end-user manually (operator-driven)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Use this for support seeding / data migrations. The SDK\'s public sign-up endpoint is ' +
          'the normal path. Password is optional — if omitted, the user can only sign in via OAuth ' +
          'or via password-reset flow. Marks the email verified by default since an operator vouched.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            password: { type: 'string', minLength: 8, maxLength: 128 },
            role: { type: 'string', minLength: 1, maxLength: 40 },
            metadata: { type: 'object', additionalProperties: true },
            emailVerified: { type: 'boolean' },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string', format: 'email' },
                emailVerified: { type: 'boolean' },
                role: { type: 'string' },
                metadata: { type: 'object', nullable: true, additionalProperties: true },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'email', 'emailVerified', 'role', 'createdAt'],
            },
            'The created end-user.',
          ),
          // NOTE: 409 is declared as its own literal key (not folded into the `errs()` spread
          // below) because the handler's catch block calls `reply.status(409)` directly — with
          // Fastify's typed reply, `.status()` only accepts status codes that appear as literal
          // keys of `schema.response`, and a spread of `errs()`'s `Record<number, JsonSchema>`
          // return type doesn't preserve individual literals. This 409 is also hand-built in the
          // handler's catch block, bypassing the normal RekeyError path — it omits `requestId`
          // (present on every other error this API returns). See the final report.
          409: errs({ 409: 'EMAIL_ALREADY_EXISTS — another end-user in this Application already uses that email.' })[409],
          ...errs({
            400:
              'METADATA_TOO_LARGE — `metadata` exceeds the size limit; or ' +
              'END_USER_ROLE_UNKNOWN — `role` is not defined for this Application; or ' +
              'VALIDATION_ERROR — a field failed schema validation.',
            ...APP_WRITE_ERRORS,
            403: APP_WRITE_ERRORS[403] + ' Or TENANT_QUOTA_EXCEEDED — the workspace end-user limit is reached.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          email: z.string().email().max(254),
          password: z.string().min(8).max(128).optional(),
          role: z.string().min(1).max(40).optional(),
          metadata: z.record(z.unknown()).optional(),
          emailVerified: z.boolean().optional(),
        })
        .parse(req.body);
      // Same 16KB ceiling every other metadata writer applies. An operator is
      // trusted with the CONTENT of this blob (it is where the OIDC claims
      // live), not with the size of the jsonb column every auth-path query
      // reads back.
      if (body.metadata !== undefined) assertMetadataWithinLimit(body.metadata);
      // Workspace ceiling. Operator-driven seeding is still creation, so it is
      // gated identically to SDK sign-up — otherwise the quota is one panel
      // click away from being irrelevant.
      await assertEndUserQuota(req.tenantId!);
      const passwordHash = body.password ? await hashPassword(body.password) : null;
      // Resolve role: explicit pick must exist in the catalog; otherwise
      // assign the application's default.
      const roleName = body.role
        ? (await endUserRolesService.assertExists(id, body.role), body.role)
        : (await endUserRolesService.getDefault(id)).name;
      try {
        const created = await prisma.endUser.create({
          data: {
            applicationId: id,
            email: body.email.toLowerCase(),
            passwordHash,
            role: roleName,
            emailVerified: body.emailVerified ?? true,
            ...(body.metadata !== undefined && { metadata: body.metadata as never }),
          },
          select: {
            id: true, email: true, emailVerified: true, role: true, metadata: true, createdAt: true,
          },
        });
        return reply.status(201).send({ success: true, data: created });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          // Same reason as the licenses 404 below: hand-building the envelope
          // bypasses `rekeyErrorHandler` and drops `requestId`.
          throw new RekeyError({
            statusCode: 409,
            code: 'EMAIL_ALREADY_EXISTS',
            message: 'An end-user with that email already exists in this Application.',
            fix: 'Pick a different email or use the existing user.',
          });
        }
        throw e;
      }
    },
  );

  app.get(
    '/:id/end-users/:euid',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Get one end-user with their passkeys + recent impersonation audits',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                endUser: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    applicationId: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    emailVerified: { type: 'boolean' },
                    role: { type: 'string' },
                    metadata: { type: 'object', nullable: true, additionalProperties: true },
                    erasedAt: { type: 'string', format: 'date-time', nullable: true },
                    erasedBy: { type: 'string', nullable: true },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    failedSignInAttempts: {
                      type: 'integer',
                      description: 'Sourced live from the Redis brute-force limiter, not a stored column.',
                    },
                    lockedUntil: { type: 'string', format: 'date-time', nullable: true },
                  },
                  required: [
                    'id', 'applicationId', 'email', 'emailVerified', 'role', 'createdAt',
                    'updatedAt', 'failedSignInAttempts', 'lockedUntil',
                  ],
                },
                passkeys: {
                  type: 'array',
                  // Bounded by construction — an end-user registers a handful of authenticators.
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      credentialId: { type: 'string' },
                      deviceName: { type: 'string', nullable: true },
                      lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                    required: ['id', 'credentialId', 'createdAt'],
                  },
                },
                recentImpersonations: {
                  type: 'array',
                  description: 'Most recent 20 impersonation-audit rows for this end-user.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      operatorUserId: { type: 'string' },
                      reason: { type: 'string', nullable: true },
                      startedAt: { type: 'string', format: 'date-time' },
                      endedAt: { type: 'string', format: 'date-time', nullable: true },
                      ip: { type: 'string', nullable: true },
                    },
                    required: ['id', 'operatorUserId', 'startedAt'],
                  },
                },
              },
              required: ['endUser', 'passkeys', 'recentImpersonations'],
            },
            'The end-user plus their passkeys and recent impersonation audit trail.',
          ),
          ...errs({
            ...APP_READ_ERRORS,
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1), euid: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'read');
      const eu = await prisma.endUser.findUnique({
        where: { id: params.euid },
        select: {
          id: true,
          applicationId: true,
          email: true,
          emailVerified: true,
          role: true,
          metadata: true,
          erasedAt: true,
          erasedBy: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!eu || eu.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }
      const [passkeys, recentImpersonations, lockState] = await Promise.all([
        prisma.webAuthnCredential.findMany({
          where: { endUserId: eu.id },
          select: { id: true, credentialId: true, deviceName: true, lastUsedAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.impersonationAudit.findMany({
          where: { endUserId: eu.id },
          orderBy: { startedAt: 'desc' },
          take: 20,
        }),
        endUserLockState(eu.applicationId, eu.email),
      ]);
      return {
        success: true,
        data: {
          // The panel has always declared `failedSignInAttempts` + `lockedUntil`
          // on this payload, but this select never returned them: the lock badge
          // read `undefined` and rendered "none" for every account, locked or
          // not. They are real now, sourced from the limiter.
          endUser: { ...eu, ...lockState },
          passkeys: passkeys.map((p) => ({
            ...p,
            lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
            createdAt: p.createdAt.toISOString(),
          })),
          recentImpersonations: recentImpersonations.map((r) => ({
            id: r.id,
            operatorUserId: r.operatorUserId,
            reason: r.reason,
            startedAt: r.startedAt.toISOString(),
            endedAt: r.endedAt?.toISOString() ?? null,
            ip: r.ip,
          })),
        },
      };
    },
  );

  app.get(
    '/:id/end-users/:euid/billing',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Get an end-user's subscriptions, payments + licenses (operator billing view)",
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                subscriptions: {
                  type: 'array',
                  description: 'Most recent 100, newest first.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] },
                      provider: { type: 'string' },
                      providerSubId: { type: 'string', nullable: true },
                      currentPeriodEnd: { type: 'string', format: 'date-time', nullable: true },
                      cancelAt: { type: 'string', format: 'date-time', nullable: true },
                      canceledAt: { type: 'string', format: 'date-time', nullable: true },
                      beneficiaryOrgId: { type: 'string', nullable: true },
                      createdAt: { type: 'string', format: 'date-time' },
                      plan: {
                        type: 'object',
                        properties: {
                          slug: { type: 'string' },
                          name: { type: 'string' },
                          kind: { type: 'string' },
                          amount: { type: 'integer' },
                          currency: { type: 'string' },
                          interval: { type: 'string', nullable: true },
                        },
                        required: ['slug', 'name', 'kind', 'amount', 'currency'],
                      },
                    },
                    required: ['id', 'status', 'provider', 'createdAt', 'plan'],
                  },
                },
                payments: {
                  type: 'array',
                  description: 'Most recent 50, newest first.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      amount: { type: 'integer' },
                      currency: { type: 'string' },
                      status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] },
                      description: { type: 'string', nullable: true },
                      providerPaymentId: { type: 'string', nullable: true },
                      subscriptionId: { type: 'string', nullable: true },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                    required: ['id', 'amount', 'currency', 'status', 'createdAt'],
                  },
                },
                licenses: {
                  type: 'array',
                  description: 'Most recent 100, newest first.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      kind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
                      status: { type: 'string' },
                      keyPrefix: { type: 'string' },
                      seatsAllowed: { type: 'integer', nullable: true },
                      organizationId: { type: 'string', nullable: true },
                      expiresAt: { type: 'string', format: 'date-time', nullable: true },
                      createdAt: { type: 'string', format: 'date-time' },
                      plan: {
                        type: 'object',
                        properties: { slug: { type: 'string' }, name: { type: 'string' } },
                        required: ['slug', 'name'],
                      },
                    },
                    required: ['id', 'kind', 'status', 'keyPrefix', 'createdAt', 'plan'],
                  },
                },
              },
              required: ['subscriptions', 'payments', 'licenses'],
            },
            "The end-user's billing history. Each array is a bounded recent-N tail, not paginated.",
          ),
          ...errs({
            ...APP_READ_ERRORS,
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1), euid: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'read');
      const existing = await prisma.endUser.findUnique({ where: { id: params.euid } });
      if (!existing || existing.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }
      const [subscriptions, payments, licenses] = await Promise.all([
        prisma.subscription.findMany({
          where: { applicationId: params.id, endUserId: params.euid },
          select: {
            id: true,
            status: true,
            provider: true,
            providerSubId: true,
            currentPeriodEnd: true,
            cancelAt: true,
            canceledAt: true,
            beneficiaryOrgId: true,
            createdAt: true,
            plan: { select: { slug: true, name: true, kind: true, amount: true, currency: true, interval: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        prisma.payment.findMany({
          where: { applicationId: params.id, endUserId: params.euid },
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            description: true,
            providerPaymentId: true,
            subscriptionId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        prisma.license.findMany({
          where: { applicationId: params.id, endUserId: params.euid },
          select: {
            id: true,
            kind: true,
            status: true,
            keyPrefix: true,
            seatsAllowed: true,
            organizationId: true,
            expiresAt: true,
            createdAt: true,
            plan: { select: { slug: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);
      return {
        success: true,
        data: {
          subscriptions: subscriptions.map((s) => ({
            ...s,
            currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
            cancelAt: s.cancelAt?.toISOString() ?? null,
            canceledAt: s.canceledAt?.toISOString() ?? null,
            createdAt: s.createdAt.toISOString(),
          })),
          payments: payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
          licenses: licenses.map((l) => ({
            ...l,
            expiresAt: l.expiresAt?.toISOString() ?? null,
            createdAt: l.createdAt.toISOString(),
          })),
        },
      };
    },
  );

  app.patch(
    '/:id/end-users/:euid',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Patch an end-user (role, metadata, verified flag)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Email is immutable (it\'s the natural key per-Application). To change a password use the ' +
          'password-reset flow. Pass `metadata: null` to clear; pass an object to overwrite — partial ' +
          'merges aren\'t supported because Json columns can\'t deep-merge atomically.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, euid: { type: 'string' } },
          required: ['id', 'euid'],
        },
        body: {
          type: 'object',
          properties: {
            role: { type: 'string', minLength: 1, maxLength: 40 },
            metadata: {},
            emailVerified: { type: 'boolean' },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string', format: 'email' },
                emailVerified: { type: 'boolean' },
                role: { type: 'string' },
                metadata: { type: 'object', nullable: true, additionalProperties: true },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'email', 'emailVerified', 'role', 'createdAt'],
            },
            'The patched end-user.',
          ),
          ...errs({
            400:
              'METADATA_TOO_LARGE — `metadata` exceeds the size limit; or ' +
              'END_USER_ROLE_UNKNOWN — `role` is not defined for this Application; or ' +
              'VALIDATION_ERROR — a field failed schema validation.',
            ...APP_WRITE_ERRORS,
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), euid: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const body = z
        .object({
          role: z.string().min(1).max(40).optional(),
          metadata: z.union([z.record(z.unknown()), z.null()]).optional(),
          emailVerified: z.boolean().optional(),
        })
        .parse(req.body);
      // Same 16KB ceiling as every other writer — see the create route above.
      // This one replaces wholesale rather than merging, so the check is on
      // exactly what will be stored.
      if (body.metadata) assertMetadataWithinLimit(body.metadata);
      // Confirm the user belongs to this Application (cross-app guard).
      const existing = await prisma.endUser.findUnique({ where: { id: params.euid } });
      if (!existing || existing.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }
      // Validate role against the catalog before writing — prevents typos
      // from creating phantom roles via the panel.
      if (body.role !== undefined) {
        await endUserRolesService.assertExists(params.id, body.role);
      }
      const updated = await prisma.endUser.update({
        where: { id: params.euid },
        data: {
          ...(body.role !== undefined && { role: body.role }),
          ...(body.emailVerified !== undefined && { emailVerified: body.emailVerified }),
          ...(body.metadata !== undefined && { metadata: body.metadata as never }),
        },
        select: {
          id: true, email: true, emailVerified: true, role: true, metadata: true, createdAt: true,
        },
      });
      return { success: true, data: updated };
    },
  );

  // DELETE /:id/end-users/:euid           → plain delete (back-compat, unchanged)
  // DELETE /:id/end-users/:euid?erasure=true → GDPR erasure (tombstone + retain)
  //
  // Plain delete relies on the schema's onDelete:Cascade FKs: the EndUser row
  // and EVERY dependent row (including financial records) are removed. Kept for
  // back-compat — same behavior as before this feature.
  //
  // Erasure (roadmap §10) is the GDPR-correct path: it hard-deletes PII/auth
  // rows, TOMBSTONES the EndUser (email anonymized, passwordHash cleared,
  // `erasedAt` set — the user can never authenticate again), and RETAINS but
  // PII-scrubs financial rows (Payment/Subscription/License/CreditLedger/Usage)
  // so accounting/legal-retention obligations are met. OWNER/ADMIN only (same
  // gate as the DSAR export — this is an irreversible, PII-dense operation).
  // See docs/data-erasure.md for the per-model matrix.
  app.delete(
    '/:id/end-users/:euid',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary:
          'Delete an end-user (cascade), or GDPR-erase them with ?erasure=true (tombstone + retain financials)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, euid: { type: 'string' } },
          required: ['id', 'euid'],
        },
        querystring: {
          type: 'object',
          properties: {
            erasure: {
              type: 'string',
              enum: ['true', 'false'],
              description:
                'When "true", performs a GDPR erasure (tombstone + anonymized financial retention) ' +
                'instead of a hard cascade delete. OWNER/ADMIN only.',
            },
          },
        },
        response: {
          200: ok(
            {
              oneOf: [
                {
                  type: 'object',
                  description: 'Plain delete (default, `?erasure` unset or "false").',
                  properties: { removed: { type: 'boolean', enum: [true] } },
                  required: ['removed'],
                },
                {
                  type: 'object',
                  description: 'GDPR erasure (`?erasure=true`).',
                  properties: {
                    erased: { type: 'boolean', description: 'False when the end-user was already a tombstone (idempotent no-op).' },
                    erasedAt: { type: 'string', format: 'date-time' },
                    alreadyErased: { type: 'boolean' },
                  },
                  required: ['erased', 'erasedAt', 'alreadyErased'],
                },
              ],
            },
            'Confirmation. Shape depends on `?erasure`.',
          ),
          ...errs({
            403:
              APP_WRITE_ERRORS[403] +
              ' Or TENANT_ROLE_INSUFFICIENT — `?erasure=true` requires the OWNER or ADMIN workspace role (no grant unlocks it).',
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
            401: APP_WRITE_ERRORS[401],
            502: 'PROVIDER_CANCEL_FAILED — a plain delete (not erasure) is refused when the billing provider will not cancel the end-user\'s active subscription (avoids leaving a live charge behind).',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), euid: z.string().min(1) })
        .parse(req.params);
      const query = z
        .object({ erasure: z.enum(['true', 'false']).optional() })
        .parse(req.query);
      const isErasure = query.erasure === 'true';

      await ensureAppAccess(req, params.id, 'write');

      // Erasure is irreversible + PII-dense — gate it to OWNER/ADMIN, matching
      // the DSAR export. (Plain delete keeps the 'write' grant authz.)
      if (isErasure && req.tenantRole !== 'OWNER' && req.tenantRole !== 'ADMIN') {
        throw new RekeyError({
          statusCode: 403,
          code: 'TENANT_ROLE_INSUFFICIENT',
          message: 'Only workspace owners and admins can erase (GDPR) an end-user.',
          fix: 'Ask an OWNER or ADMIN to process the erasure request.',
        });
      }

      const existing = await prisma.endUser.findUnique({ where: { id: params.euid } });
      if (!existing || existing.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }

      if (isErasure) {
        // Stop any still-billing provider subscription before tombstoning —
        // otherwise the provider keeps charging the (now erased) user. Done
        // OUTSIDE the erasure transaction (it makes network calls) and
        // best-effort: a provider error must NOT block the GDPR erasure.
        const erasureApp = await prisma.application.findUniqueOrThrow({ where: { id: params.id } });
        const cancelResult = await billingService
          .cancelActiveProviderSubscriptionsForEndUser({
            application: erasureApp,
            endUserId: params.euid,
            log: req.log,
          })
          .catch((err) => {
            req.log.warn({ err, endUserId: params.euid }, 'end-user erasure: provider cancel sweep failed');
            return { attempted: 0, failed: 0 };
          });
        const result = await eraseEndUser({
          applicationId: params.id,
          endUserId: params.euid,
          operatorUserId: req.tenantUser!.id,
        });
        // Audit the erasure (no-op repeats are still logged for completeness).
        void recordSecurityEvent({
          type: 'end_user.erased',
          actorType: 'operator',
          actorId: req.tenantUser!.id,
          tenantId: req.tenantId!,
          applicationId: params.id,
          ...requestContext(req),
          metadata: {
            endUserId: params.euid,
            erased: result.erased,
            counts: result.counts,
            providerSubscriptionsCanceled: cancelResult.attempted,
            providerCancelFailures: cancelResult.failed,
          },
        });
        return {
          success: true,
          data: { erased: true, erasedAt: result.erasedAt, alreadyErased: !result.erased },
        };
      }

      // Before the cascade removes the row, stop any still-billing provider
      // subscription — otherwise Stripe/PayPal/Razorpay keeps charging a user
      // that no longer exists.
      //
      // This path FAILS CLOSED, unlike the erasure branch above. If the provider
      // cancel does not succeed we refuse the delete, because the alternative is
      // a live card being charged for a user who no longer exists in any system
      // the operator can see — and once the row is gone there is nothing left to
      // retry from. Refusing is recoverable; deleting is not.
      //
      // Erasure stays best-effort deliberately: it answers a GDPR request with a
      // legal deadline, and blocking that on a third party being down would be
      // the worse failure. The asymmetry is the decision, not an oversight.
      const app = await prisma.application.findUniqueOrThrow({ where: { id: params.id } });
      let cancelResult: { attempted: number; failed: number };
      try {
        cancelResult = await billingService.cancelActiveProviderSubscriptionsForEndUser({
          application: app,
          endUserId: params.euid,
          log: req.log,
        });
      } catch (err) {
        // The sweep itself blew up (credential decrypt, registry lookup). It
        // previously degraded to `{attempted: 0, failed: 0}`, which read as
        // "nothing to cancel" and let the delete proceed.
        req.log.error({ err, endUserId: params.euid }, 'end-user delete: provider cancel sweep failed');
        cancelResult = { attempted: -1, failed: -1 };
      }

      if (cancelResult.failed !== 0) {
        void recordSecurityEvent({
          type: 'end_user.delete_blocked',
          actorType: 'operator',
          actorId: req.tenantUser!.id,
          tenantId: req.tenantId!,
          applicationId: params.id,
          ...requestContext(req),
          metadata: {
            endUserId: params.euid,
            reason: 'provider_subscription_cancel_failed',
            attempted: cancelResult.attempted,
            failed: cancelResult.failed,
          },
        });
        throw new RekeyError({
          statusCode: 502,
          code: 'PROVIDER_CANCEL_FAILED',
          message:
            'This end-user still has an active subscription that the payment provider refused to cancel, so the delete was refused to avoid leaving a live charge behind.',
          fix: 'Check the provider dashboard and the Activity log, cancel the subscription there or fix the stored credentials, then retry the delete. To satisfy an erasure request without waiting, use the erase endpoint instead — it tombstones the user and does not block on the provider.',
        });
      }

      await prisma.endUser.delete({ where: { id: params.euid } });

      // Audit the operator mutation (durable: a deletion is a sensitive action).
      void recordSecurityEvent({
        type: 'end_user.deleted',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: params.id,
        ...requestContext(req),
        metadata: {
          endUserId: params.euid,
          providerSubscriptionsCanceled: cancelResult.attempted,
          providerCancelFailures: cancelResult.failed,
        },
      });

      // Outbound webhook — `user.deleted` (registered event). Fire-and-forget,
      // same contract as `user.created` / `user.erased`.
      emitDetached({
        applicationId: params.id,
        type: 'user.deleted',
        data: { user: { id: params.euid } },
      });

      return { success: true, data: { removed: true } };
    },
  );

  // ---------- End-user credits (operator view + manual grant) ----------

  app.get(
    '/:id/end-users/:euid/credits',
    {
      schema: {
        tags: ['Tenant · Credits'],
        security: [{ tenantSession: [] }],
        summary: "Get an end-user's credit balance + recent ledger",
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                balance: { type: 'integer' },
                ledger: {
                  type: 'array',
                  // Bounded by construction: this route always requests limit:50.
                  items: ref('CreditLedgerEntry'),
                },
              },
              required: ['balance', 'ledger'],
            },
            "The end-user's credit balance and most recent 50 ledger entries.",
          ),
          ...errs({
            ...APP_READ_ERRORS,
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1), euid: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'read');
      const existing = await prisma.endUser.findUnique({ where: { id: params.euid } });
      if (!existing || existing.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }
      const [balance, ledger] = await Promise.all([
        creditsService.getBalance(params.id, { endUserId: params.euid }),
        creditsService.listLedger(params.id, { endUserId: params.euid }, { limit: 50 }),
      ]);
      return { success: true, data: { balance, ledger } };
    },
  );

  app.post(
    '/:id/end-users/:euid/credits/grant',
    {
      // Generic Idempotency-Key HEADER support (scoped to the workspace).
      // Distinct from the body-level `idempotencyKey`, which dedupes at the
      // credit-ledger level and keeps working unchanged.
      config: { idempotency: true },
      schema: {
        tags: ['Tenant · Credits'],
        security: [{ tenantSession: [] }],
        summary: 'Manually grant / refund / adjust an end-user\'s credits',
        description:
          'Requires **billing-write** access to this Application — OWNER/ADMIN, or a MEMBER ' +
          'with an `APP_ADMIN` or `APP_BILLING` grant on it.\n\n' +
          'Positive `amount` adds credits (GRANT / REFUND). Negative `amount` with reason ADJUST ' +
          'removes them (refused if it would overdraw). Idempotent on `idempotencyKey` when provided.',
        body: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'integer', maximum: 2147483647 },
            reason: { type: 'string', enum: ['GRANT', 'REFUND', 'ADJUST'] },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                balance: { type: 'integer', description: 'Balance after applying this grant.' },
                entryId: { type: 'string' },
                applied: { type: 'boolean' },
              },
              required: ['balance', 'entryId', 'applied'],
            },
            'The ledger entry created and the resulting balance.',
          ),
          ...errs({
            400: 'CREDITS_AMOUNT_INVALID — `amount` is zero, non-integer, or (for a debit) would overdraw the balance.',
            ...APP_BILLING_WRITE_ERRORS,
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
          }),
        },
      },
    },
    async (req, reply) => {
      const params = z.object({ id: z.string().min(1), euid: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'billing-write');
      const existing = await prisma.endUser.findUnique({ where: { id: params.euid } });
      if (!existing || existing.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }
      const body = GrantCreditsRequestSchema.parse(req.body);
      const result = await creditsService.grant({
        applicationId: params.id,
        endUserId: params.euid,
        amount: body.amount,
        reason: body.reason,
        ...(body.idempotencyKey !== undefined && { idempotencyKey: body.idempotencyKey }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return reply.status(201).send({ success: true, data: result });
    },
  );

  // ---------- GDPR / DSAR data export ----------
  //
  // GET /:id/end-users/:euid/export
  //
  // Single JSON document of everything Rekey stores about one end-user, so
  // operators can answer data-subject access requests (GDPR Art. 15 / CCPA).
  // OWNER/ADMIN only (same gate as the audit CSV export — this is PII-dense).
  //
  // SECURITY: every select below is an explicit field list. It must NEVER
  // include credential material: no passwordHash, no token hashes, no
  // license keyHash, no MFA secret/backup-code ciphertexts, no WebAuthn
  // public keys. Sessions/MFA/licenses are exported as METADATA only.
  app.get(
    '/:id/end-users/:euid/export',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Export everything stored about one end-user as JSON (GDPR/DSAR)',
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\nRequires **read** access to ' +
          'this Application — OWNER/ADMIN, or a MEMBER holding any grant on it (grant-less ' +
          'legacy members keep workspace-wide read).\n\n' +
          'Returns a downloadable JSON document: profile, OAuth identities, session metadata ' +
          '(no token material), MFA enrollment metadata (no secrets), passkey metadata, ' +
          'organization memberships, subscriptions, payments, licenses (key prefix only), ' +
          'credit balance + ledger, usage records (capped — see `notes`), security events, and ' +
          'impersonation audits. OWNER/ADMIN only.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, euid: { type: 'string' } },
          required: ['id', 'euid'],
        },
        response: {
          // NOT the {success, data} envelope: this handler sends the document itself
          // under a Content-Disposition attachment header (a downloadable file),
          // bypassing the envelope every other route uses.
          //
          // It used to be declared `raw(..., 'application/json')`, which emits
          // `{"type": "string"}` — describing a JSON string where the endpoint
          // returns a JSON object, so a generated client typed this
          // `Promise<string>`. The real shape is the `EndUserExport` component,
          // written against `EndUserExportDocument` in @rekey.dev/shared-types.
          200: {
            description:
              'Downloadable JSON document of everything Rekey stores about this end-user ' +
              '(GDPR/DSAR). Sent as `attachment; filename="end-user-<id>-export.json"`, and ' +
              'NOT wrapped in the {success, data} envelope — the body is the document itself.',
            content: { 'application/json': { schema: ref('EndUserExport') } },
          },
          ...errs({
            ...APP_READ_ERRORS,
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
            403: APP_READ_ERRORS[403] + ' Or TENANT_ROLE_INSUFFICIENT — this route requires the OWNER or ADMIN workspace role (no grant unlocks it).',
          }),
        },
      },
    },
    async (req, reply) => {
      const params = z.object({ id: z.string().min(1), euid: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'read');
      const endUser = await prisma.endUser.findUnique({
        where: { id: params.euid },
        // Explicit allowlist — NO passwordHash.
        select: {
          id: true,
          applicationId: true,
          email: true,
          emailVerified: true,
          role: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!endUser || endUser.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }

      // Bounded everywhere: a single pathological user must not OOM the API.
      const SESSIONS_CAP = 1000;
      const PAYMENTS_CAP = 5000;
      const LEDGER_CAP = 5000;
      const USAGE_CAP = 10000;
      const EVENTS_CAP = 5000;

      const [
        oauthIdentities,
        sessions,
        mfaCredential,
        passkeys,
        memberships,
        subscriptions,
        payments,
        licenses,
        creditBalances,
        creditLedger,
        usageRecords,
        securityEvents,
        impersonations,
        lockState,
      ] = await Promise.all([
        prisma.oAuthIdentity.findMany({
          where: { endUserId: endUser.id },
          select: { id: true, provider: true, providerAccountId: true, email: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        // Session METADATA only — never tokenHash.
        prisma.refreshToken.findMany({
          where: { endUserId: endUser.id },
          select: {
            id: true,
            kind: true,
            userAgent: true,
            ip: true,
            activeOrganizationId: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: SESSIONS_CAP,
        }),
        // MFA enrollment metadata only — never the encrypted secret/backup codes.
        prisma.mfaCredential.findUnique({
          where: { endUserId: endUser.id },
          select: { enrolledAt: true, createdAt: true, updatedAt: true },
        }),
        prisma.webAuthnCredential.findMany({
          where: { endUserId: endUser.id },
          select: { id: true, credentialId: true, deviceName: true, lastUsedAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.organizationMembership.findMany({
          where: { endUserId: endUser.id },
          select: {
            role: true,
            createdAt: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.subscription.findMany({
          where: { applicationId: params.id, endUserId: endUser.id },
          select: {
            id: true,
            status: true,
            provider: true,
            providerSubId: true,
            currentPeriodEnd: true,
            cancelAt: true,
            canceledAt: true,
            beneficiaryOrgId: true,
            metadata: true,
            createdAt: true,
            plan: { select: { slug: true, name: true, kind: true, amount: true, currency: true, interval: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.payment.findMany({
          where: { applicationId: params.id, endUserId: endUser.id },
          select: {
            id: true,
            subscriptionId: true,
            amount: true,
            currency: true,
            status: true,
            providerPaymentId: true,
            description: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: PAYMENTS_CAP,
        }),
        // License metadata — keyPrefix only, never keyHash.
        prisma.license.findMany({
          where: { applicationId: params.id, endUserId: endUser.id },
          select: {
            id: true,
            kind: true,
            status: true,
            keyPrefix: true,
            seatsAllowed: true,
            organizationId: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            plan: { select: { slug: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.creditBalance.findMany({
          where: { applicationId: params.id, endUserId: endUser.id },
          select: { balance: true, createdAt: true, updatedAt: true },
        }),
        prisma.creditLedger.findMany({
          where: { applicationId: params.id, endUserId: endUser.id },
          select: {
            id: true,
            delta: true,
            reason: true,
            balanceAfter: true,
            description: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: LEDGER_CAP,
        }),
        prisma.usageRecord.findMany({
          where: { endUserId: endUser.id, meter: { applicationId: params.id } },
          select: {
            id: true,
            quantity: true,
            occurredAt: true,
            createdAt: true,
            meter: { select: { slug: true, name: true, unit: true } },
          },
          orderBy: { occurredAt: 'desc' },
          take: USAGE_CAP,
        }),
        prisma.securityEvent.findMany({
          where: { applicationId: params.id, actorType: 'end_user', actorId: endUser.id },
          select: { id: true, type: true, ip: true, userAgent: true, metadata: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: EVENTS_CAP,
        }),
        prisma.impersonationAudit.findMany({
          where: { endUserId: endUser.id },
          select: { id: true, operatorUserId: true, reason: true, startedAt: true, endedAt: true, ip: true },
          orderBy: { startedAt: 'desc' },
        }),
        endUserLockState(endUser.applicationId, endUser.email),
      ]);

      const notes = [
        'Sessions, payments, credit ledger, usage records and security events are capped at the ' +
          `most recent ${SESSIONS_CAP}, ${PAYMENTS_CAP}, ${LEDGER_CAP}, ${USAGE_CAP} and ${EVENTS_CAP} rows respectively (newest first).`,
        'Credential material (password hashes, session token hashes, MFA secrets/backup codes, ' +
          'license key hashes, passkey public keys) is never included in exports.',
      ];
      if (usageRecords.length === USAGE_CAP) {
        notes.push(`usageRecords hit the ${USAGE_CAP}-row cap — older rows exist but are not included.`);
      }

      const document = {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        applicationId: params.id,
        notes,
        endUser: {
          ...endUser,
          // Both from the Redis limiter, not the (now dropped) EndUser columns.
          // Kept on the document because `EndUserExportProfile` in the published
          // shared-types package declares them: a DSAR export losing fields is a
          // breaking change for anyone archiving these documents.
          ...lockState,
          createdAt: endUser.createdAt.toISOString(),
          updatedAt: endUser.updatedAt.toISOString(),
        },
        oauthIdentities: oauthIdentities.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })),
        sessions: sessions.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          revokedAt: s.revokedAt?.toISOString() ?? null,
        })),
        mfa: mfaCredential
          ? {
              enrolled: mfaCredential.enrolledAt !== null,
              enrolledAt: mfaCredential.enrolledAt?.toISOString() ?? null,
              createdAt: mfaCredential.createdAt.toISOString(),
              updatedAt: mfaCredential.updatedAt.toISOString(),
            }
          : null,
        passkeys: passkeys.map((p) => ({
          ...p,
          lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
          createdAt: p.createdAt.toISOString(),
        })),
        organizationMemberships: memberships.map((m) => ({
          organizationId: m.organization.id,
          organizationName: m.organization.name,
          organizationSlug: m.organization.slug,
          role: m.role,
          createdAt: m.createdAt.toISOString(),
        })),
        subscriptions: subscriptions.map((s) => ({
          ...s,
          currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
          cancelAt: s.cancelAt?.toISOString() ?? null,
          canceledAt: s.canceledAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
        })),
        payments: payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
        licenses: licenses.map((l) => ({
          ...l,
          expiresAt: l.expiresAt?.toISOString() ?? null,
          revokedAt: l.revokedAt?.toISOString() ?? null,
          createdAt: l.createdAt.toISOString(),
        })),
        creditBalance: creditBalances.reduce((sum, b) => sum + b.balance, 0),
        creditLedger: creditLedger.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
        usageRecords: usageRecords.map((u) => ({
          id: u.id,
          meterSlug: u.meter.slug,
          meterName: u.meter.name,
          unit: u.meter.unit,
          quantity: u.quantity,
          occurredAt: u.occurredAt.toISOString(),
          createdAt: u.createdAt.toISOString(),
        })),
        securityEvents: securityEvents.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
        impersonations: impersonations.map((r) => ({
          ...r,
          startedAt: r.startedAt.toISOString(),
          endedAt: r.endedAt?.toISOString() ?? null,
        })),
      };

      void recordSecurityEvent({
        type: 'end_user.data_exported',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: params.id,
        ...requestContext(req),
        metadata: { endUserId: endUser.id },
      });

      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="end-user-${endUser.id}-export.json"`,
        )
        .send(JSON.stringify(document, null, 2));
    },
  );

  // ---------- Operator impersonation ----------
  //
  // POST /:id/end-users/:euid/impersonate
  //
  // OWNER/ADMIN-only. Mints a 5-minute `eu_access` token whose payload
  // carries `imp = <operator user id>` and `impid = <audit row id>` alongside
  // the normal `sub` (end-user id). The operator's customer-facing service uses
  // this token much like a real session token — most routes the user could call
  // become callable as them.
  //
  // Two bounds, not one. The lifetime was the only bound for a long time, and
  // it was not enough on its own:
  //
  //   - **Revocable.** The audit row is minted FIRST and its id rides in the
  //     token, so `requireUserSession` can refuse a token whose row has been
  //     ended. Before this, `impersonation_audits.endedAt` was described in the
  //     schema and written by nothing — a minted token ran to expiry no matter
  //     what anyone did, and "end impersonation" was not an operation that
  //     existed. See POST .../impersonate/end below.
  //   - **Bounded in what it can do.** `refuseWhileImpersonating`
  //     (middleware/impersonation.ts) refuses the credential-changing routes.
  //     A password change, an MFA rebind or a passkey enrolment made during
  //     impersonation outlives the token permanently, which is the one thing a
  //     5-minute limit cannot contain.
  app.post(
    '/:id/end-users/:euid/impersonate',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Mint a short-lived impersonation token for an end-user (audited)',
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\nRequires **read** access to ' +
          'this Application — OWNER/ADMIN, or a MEMBER holding any grant on it (grant-less ' +
          'legacy members keep workspace-wide read).\n\n' +
          'Operator-as-user access token, 5-minute lifetime, no refresh. Every minting writes ' +
          'an `impersonation_audits` row. Use sparingly — every action taken with this token ' +
          'is attributed to the end-user in their own activity logs, with the operator id in ' +
          'the JWT `imp` claim for downstream attribution.',
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string', maxLength: 280, description: 'Short justification, captured in audit.' },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                impersonationId: { type: 'string' },
                accessToken: { type: 'string' },
                accessTokenExpiresAt: { type: 'string', format: 'date-time' },
                impersonatedUser: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    role: { type: 'string' },
                  },
                  required: ['id', 'email', 'role'],
                },
                warning: { type: 'string' },
              },
              required: ['impersonationId', 'accessToken', 'accessTokenExpiresAt', 'impersonatedUser', 'warning'],
            },
            'A 5-minute impersonation access token (no refresh) plus the audit row id.',
          ),
          ...errs({
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
            401: APP_READ_ERRORS[401],
            403: APP_READ_ERRORS[403] + ' Or TENANT_ROLE_INSUFFICIENT — this route requires the OWNER or ADMIN workspace role (no grant unlocks it).',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), euid: z.string().min(1) })
        .parse(req.params);
      const body = z
        .object({ reason: z.string().max(280).optional() })
        .parse(req.body ?? {});
      await ensureAppAccess(req, params.id, 'read');
      const endUser = await prisma.endUser.findUnique({ where: { id: params.euid } });
      if (!endUser || endUser.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }
      const { issueImpersonationToken } = await import('../../lib/jwt.js');
      const impApp = await prisma.application.findUniqueOrThrow({
        where: { id: endUser.applicationId },
        select: { tokenGeneration: true },
      });
      const ua = req.headers['user-agent'];
      // Any session this operator still has open on this user is ended first.
      // Otherwise re-minting would leave the previous token live and
      // unrevocable-by-id: ending the new one would not touch it.
      await prisma.impersonationAudit.updateMany({
        where: {
          applicationId: params.id,
          endUserId: endUser.id,
          operatorUserId: req.tenantUser!.id,
          endedAt: null,
        },
        data: { endedAt: new Date() },
      });
      // The audit row is created BEFORE the token, because its id is what makes
      // the token revocable — see the `impid` claim in lib/jwt.ts.
      const audit = await prisma.impersonationAudit.create({
        data: {
          applicationId: params.id,
          tenantId: req.tenantId!,
          operatorUserId: req.tenantUser!.id,
          endUserId: endUser.id,
          reason: body.reason ?? null,
          userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
          ip: req.ip || null,
        },
      });
      const minted = issueImpersonationToken(
        endUser.id,
        endUser.applicationId,
        req.tenantUser!.id,
        impApp.tokenGeneration,
        audit.id,
      );
      return {
        success: true,
        data: {
          impersonationId: audit.id,
          accessToken: minted.token,
          accessTokenExpiresAt: minted.expiresAt.toISOString(),
          impersonatedUser: {
            id: endUser.id,
            email: endUser.email,
            role: endUser.role,
          },
          warning:
            'This token expires in 5 minutes and has NO refresh. Every action taken with it is recorded with the `imp` claim pointing at your operator id. It cannot change this account\'s password, MFA or passkeys, and you can revoke it early via POST .../impersonate/end.',
        },
      };
    },
  );

  // POST /:id/end-users/:euid/impersonate/end
  //
  // The kill switch the audit trail always claimed to have. Ends every live
  // impersonation session on this end-user — whoever started them — by stamping
  // `endedAt`, which `requireUserSession` reads on every request carrying an
  // `imp` token. So this revokes the credential, it does not merely annotate
  // history.
  //
  // Deliberately not scoped to the calling operator: the case that matters is
  // "someone is impersonating this user and should not be", and an OWNER/ADMIN
  // investigating that must be able to stop it without being the one who
  // started it. Idempotent — ending nothing returns `{ ended: 0 }`.
  app.post(
    '/:id/end-users/:euid/impersonate/end',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke every live impersonation session on an end-user',
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\n' +
          'Stamps `endedAt` on every open `impersonation_audits` row for this end-user, ' +
          'which immediately invalidates the impersonation tokens those rows issued — any ' +
          'operator, not just you. Idempotent.',
        response: {
          200: ok(
            { type: 'object', properties: { ended: { type: 'integer' } }, required: ['ended'] },
            'Count of impersonation sessions ended. 0 when none were live (idempotent).',
          ),
          ...errs({
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
            401: APP_READ_ERRORS[401],
            403: APP_READ_ERRORS[403] + ' Or TENANT_ROLE_INSUFFICIENT — this route requires the OWNER or ADMIN workspace role (no grant unlocks it).',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), euid: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'read');
      const endUser = await prisma.endUser.findUnique({ where: { id: params.euid } });
      if (!endUser || endUser.applicationId !== params.id) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `End-user "${params.euid}" not found in this Application.`,
          fix: 'List end-users to confirm the id.',
        });
      }
      const result = await prisma.impersonationAudit.updateMany({
        where: { applicationId: params.id, endUserId: endUser.id, endedAt: null },
        data: { endedAt: new Date() },
      });
      return { success: true, data: { ended: result.count } };
    },
  );

  // ---------- Session kill-switch ----------
  //
  // Rotate the app's end-user session generation: every live access token dies
  // immediately (signed with a key derived from the old generation) and all
  // refresh tokens are revoked. Use when a secret leaks or an incident requires
  // forcing every end-user to re-authenticate. OWNER/ADMIN only; irreversible.
  app.post(
    '/:id/rotate-sessions',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Force-logout every end-user of this Application (session kill-switch)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Bumps the app token generation (invalidating all live end-user access + ' +
          'MFA-challenge tokens) and revokes every active refresh token. End-users ' +
          'must sign in again. Irreversible.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        // No `body` schema is declared, and the handler never reads req.body — confirmed this
        // route needs no request body (deliberately left undeclared, not an oversight).
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                tokenGeneration: { type: 'integer' },
                sessionsRevoked: { type: 'integer' },
              },
              required: ['tokenGeneration', 'sessionsRevoked'],
            },
            'The new token generation and how many refresh tokens were revoked.',
          ),
          ...errs(APP_WRITE_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const result = await applicationsService.rotateSessions(id);
      // Awaited (not fire-and-forget): the kill-switch is a rare, deliberate
      // incident action — we want its audit record durably written before the
      // response. recordSecurityEvent never throws.
      await recordSecurityEvent({
        type: 'app.sessions_rotated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: {
          tokenGeneration: result.tokenGeneration,
          sessionsRevoked: result.sessionsRevoked,
        },
      });
      return { success: true, data: result };
    },
  );

  // Rotate the Application's publishable key (rp_pub_*) with a grace window.
  // Dual-key: the old key keeps working until `graceDays` passes, so clients
  // baked with it (shipped bundles, cached SPAs, desktop installs) keep working
  // while you roll out the new key. OWNER/ADMIN only.
  const RotatePublicKeyBody = z.object({
    graceDays: z.number().int().min(1).max(90).optional(),
    // Rotate even if a previous key is still inside its grace window (drops it).
    // The leaked-key path; default false rejects an accidental double-rotate.
    force: z.boolean().optional(),
  });
  app.post(
    '/:id/rotate-public-key',
    {
      // Every field is optional, so a caller may POST with no body at all.
      // Fastify validates a missing body against `{type:'object'}` and answers
      // 400 "body must be object" — the same trap documented on tenant-mfa's
      // /setup route. Default it to {} before schema validation runs.
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Rotate the publishable key (dual-key grace window)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Mints a new rp_pub_ key and keeps the old one valid for `graceDays` (default 30, ' +
          'max 90) so clients shipped with the old key keep working until you redeploy. ' +
          'Roll the new key out to your frontends/installs during the window. Body is optional ' +
          '— POST with no body to rotate with the defaults.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            graceDays: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
            force: { type: 'boolean', default: false },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                publicKey: { type: 'string', description: 'The new rp_pub_ key.' },
                previousPublicKey: { type: 'string', nullable: true },
                previousPublicKeyValidUntil: { type: 'string', format: 'date-time', nullable: true },
              },
              required: ['publicKey', 'previousPublicKey', 'previousPublicKeyValidUntil'],
            },
            'The rotated Application (new + previous publishable key, with the grace deadline).',
          ),
          ...errs({
            409: 'PUBLIC_KEY_ROTATION_IN_GRACE — a previous key is still inside its grace window; pass `force: true` to drop it and rotate anyway.',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = RotatePublicKeyBody.parse(req.body ?? {});
      const updated = await applicationsService.rotatePublicKey({
        applicationId: id,
        ...(body.graceDays !== undefined && { graceDays: body.graceDays }),
        ...(body.force !== undefined && { force: body.force }),
      });
      // Awaited — key rotation is a deliberate, incident-grade action; persist
      // the audit record before responding.
      await recordSecurityEvent({
        type: 'app.public_key.rotated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: {
          previousPublicKeyValidUntil: updated.previousPublicKeyValidUntil?.toISOString() ?? null,
        },
      });
      return {
        success: true,
        data: {
          publicKey: updated.publicKey,
          previousPublicKey: updated.previousPublicKey,
          previousPublicKeyValidUntil: updated.previousPublicKeyValidUntil,
        },
      };
    },
  );

  // ---------- Hosted customer portal (Portal V2) ----------

  // Opt this Application into (or out of) the Rekey-hosted customer portal at
  // portal.rekey.dev/<slug>, and set its branding. Enabling auto-allows the
  // portal origin for this app's publishable key. OWNER/ADMIN.
  // `.strict()` (applied below): all-optional config patch, so an unrecognised
  // key is the only thing left to validate. See the auth-config note above.
  const PortalConfigBody = z.object({
    enabled: z.boolean().optional(),
    branding: z.record(z.unknown()).optional(),
    // Custom domain (hostname only, no scheme/path). Empty string clears it.
    portalDomain: z
      .union([
        z.literal(''),
        z.string().max(253).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'must be a bare hostname like billing.yourapp.com'),
      ])
      .optional(),
  }).strict();
  app.patch(
    '/:id/portal',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Update hosted customer portal settings (enable/disable, branding)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            branding: { type: 'object', additionalProperties: true },
            portalDomain: { type: 'string' },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                hostedPortalEnabled: { type: 'boolean' },
                portalDomain: { type: 'string', nullable: true },
                portalDomainVerifiedAt: { type: 'string', format: 'date-time', nullable: true },
                portalBranding: { type: 'object', nullable: true, additionalProperties: true },
              },
              required: ['hostedPortalEnabled', 'portalDomain', 'portalDomainVerifiedAt', 'portalBranding'],
            },
            'The Application, patched portal configuration.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `portalDomain` is not a bare hostname, or a field failed schema validation.',
            ...APP_WRITE_ERRORS,
            409: 'PORTAL_DOMAIN_TAKEN — another Application already uses that portal domain.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = PortalConfigBody.parse(req.body ?? {});
      let updated;
      try {
        updated = await applicationsService.updatePortalConfig({
          applicationId: id,
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          ...(body.branding !== undefined && { branding: body.branding }),
          ...(body.portalDomain !== undefined && { portalDomain: body.portalDomain }),
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          throw new RekeyError({
            statusCode: 409,
            code: 'PORTAL_DOMAIN_TAKEN',
            message: 'That portal domain is already in use by another application.',
            fix: 'Pick a different hostname.',
          });
        }
        throw e;
      }
      void recordSecurityEvent({
        type: 'app.portal_config_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { enabled: updated.hostedPortalEnabled },
      });
      return {
        success: true,
        data: {
          hostedPortalEnabled: updated.hostedPortalEnabled,
          portalDomain: updated.portalDomain,
          portalDomainVerifiedAt: updated.portalDomainVerifiedAt,
          portalBranding: updated.portalBranding,
        },
      };
    },
  );

  // ---------- Registered OAuth clients (RFC 7591 inbound) ----------
  //
  // The OTHER direction from `/oauth` on this Application. That surface is
  // outbound — which external providers this Application's users may sign in
  // WITH. These are inbound: clients registered against this Application, which
  // is acting as their authorization server.
  //
  // Registration is unauthenticated by design (RFC 7591, gated per Application
  // by `authConfig.dynamicClientRegistration`), so until now an operator could
  // neither see what had registered nor remove it. Open registration you cannot
  // audit is not a considered trade-off, it is an oversight.

  app.get(
    '/:id/oauth-clients',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'List OAuth clients registered against this Application',
        description:
          'Clients that registered with this Application as their authorization server ' +
          '(RFC 7591 dynamic registration, or the MCP connector flow). Requires **read** ' +
          'access to the Application.\n\n' +
          'No secrets are returned because none exist: registration issues PUBLIC clients ' +
          'that authenticate with PKCE, so the `client_id` is not confidential.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          // Paged, not a bare array: registrations accumulate — every MCP
          // client that ever connected leaves one — so a caller needs `total`
          // to know it is not looking at a truncated list.
          200: okPage(
            {
              type: 'object',
              properties: {
                clientId: { type: 'string' },
                clientName: { type: 'string', nullable: true },
                redirectUris: { type: 'array', items: { type: 'string' } },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['clientId', 'clientName', 'redirectUris', 'createdAt'],
            },
            'A page of registered clients, newest first.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...APP_READ_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [rows, total] = await Promise.all([
        prisma.oAuthClient.findMany({
          where: { applicationId: id },
          orderBy: { createdAt: 'desc' },
          take,
          skip,
          select: { id: true, clientName: true, redirectUris: true, createdAt: true },
        }),
        prisma.oAuthClient.count({ where: { applicationId: id } }),
      ]);
      return {
        success: true,
        data: paged(
          rows.map((r) => ({
            clientId: r.id,
            clientName: r.clientName,
            redirectUris: r.redirectUris,
            createdAt: r.createdAt,
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.delete(
    '/:id/oauth-clients/:clientId',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke a registered OAuth client',
        description:
          'Deletes the client registration. Authorization codes and tokens already issued to ' +
          'it stop being redeemable, because both are resolved through the client row. ' +
          'Requires **write** access to the Application.\n\n' +
          'Scoped by `applicationId` as well as by client id: a client id belonging to ' +
          'another Application answers 404 rather than deleting across the tenancy boundary.',
        params: {
          type: 'object',
          required: ['id', 'clientId'],
          properties: { id: { type: 'string' }, clientId: { type: 'string' } },
        },
        response: {
          200: ok(
            { type: 'object', properties: { revoked: { type: 'boolean' } }, required: ['revoked'] },
            'The client registration is gone.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'OAUTH_CLIENT_NOT_FOUND — no such client on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      const clientId = String((req.params as { clientId?: string }).clientId ?? '');
      await ensureAppAccess(req, id, 'write');
      // deleteMany, not delete: it takes the applicationId in the same
      // statement, so a client id from another Application cannot be removed
      // by guessing it. A count of 0 is the 404.
      const { count } = await prisma.oAuthClient.deleteMany({
        where: { id: clientId, applicationId: id },
      });
      if (count === 0) {
        throw new RekeyError({
          statusCode: 404,
          code: 'OAUTH_CLIENT_NOT_FOUND',
          message: 'No such OAuth client on this Application.',
          fix: 'List the registered clients to get a current client id.',
        });
      }
      return { success: true, data: { revoked: true } };
    },
  );

  // ---------- Network access controls (IP allowlist + per-app CORS) ----------

  // `.strict()`: both fields are optional and replace-in-full, so `{ipAllowlst:
  // [...]}` used to answer 200 having changed nothing — an operator believing
  // they had locked their secret keys to an office CIDR. See auth-config above.
  const AccessConfigBody = z.object({
    // CIDRs or bare IPs (v4/v6). Enforced on server-side secret-key calls only.
    ipAllowlist: z
      .array(z.string().min(1).max(64).regex(/^[0-9a-fA-F:.\/]+$/, 'must be an IP or CIDR'))
      .max(200)
      .optional(),
    // Browser origins (scheme://host[:port], no path) folded into the CORS allowlist.
    corsOrigins: z
      .array(z.string().max(256).regex(/^https?:\/\/[^/\s]+$/, 'must be an origin like https://app.example.com'))
      .max(100)
      .optional(),
  }).strict();

  app.get(
    '/:id/access',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Get the Application IP allowlist + CORS origins',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: ok(ref('AccessConfig'), 'The IP allowlist and CORS origins.'),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const app2 = await prisma.application.findUniqueOrThrow({
        where: { id },
        select: { ipAllowlist: true, corsOrigins: true },
      });
      return { success: true, data: app2 };
    },
  );

  app.put(
    '/:id/access',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Set the Application IP allowlist (secret-key calls) + CORS origins',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'ipAllowlist: CIDRs/IPs that server-side secret keys must call from (empty = ' +
          'allow all). corsOrigins: browser origins the SDK calls from, folded into the ' +
          'API CORS allowlist. Each field is replace-in-full when provided.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            ipAllowlist: {
              type: 'array',
              maxItems: 200,
              items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[0-9a-fA-F:.\\/]+$' },
            },
            corsOrigins: {
              type: 'array',
              maxItems: 100,
              items: { type: 'string', maxLength: 256, pattern: '^https?://[^/\\s]+$' },
            },
          },
        },
        response: {
          200: ok(ref('AccessConfig'), 'The Application, patched IP allowlist / CORS origins.'),
          ...errs({
            400: 'VALIDATION_ERROR — an entry is not a valid IP/CIDR or origin, or a field failed schema validation.',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = AccessConfigBody.parse(req.body ?? {});
      const updated = await prisma.application.update({
        where: { id },
        data: {
          ...(body.ipAllowlist !== undefined && { ipAllowlist: body.ipAllowlist }),
          ...(body.corsOrigins !== undefined && { corsOrigins: body.corsOrigins }),
        },
        select: { ipAllowlist: true, corsOrigins: true },
      });
      // CORS origins are cached in-process — refresh now so the change is live.
      if (body.corsOrigins !== undefined) await refreshCorsOrigins();
      void recordSecurityEvent({
        type: 'app.access_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { ipAllowlist: updated.ipAllowlist, corsOrigins: updated.corsOrigins },
      });
      return { success: true, data: updated };
    },
  );

  // ---------- End-user roles (RBAC catalog) ----------
  //
  // Per-Application catalog of roles that EndUser.role validates against.
  // Single default role per Application — assigned to every public sign-up.
  // Operators manage names + isDefault here; mutations to EndUser.role
  // route through the catalog (assertExists).

  app.get(
    '/:id/end-user-roles',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'List the role catalog for an Application',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        response: {
          // Bounded by construction — an operator-curated catalog, not a table that grows
          // with end-user signups.
          200: okArray(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                applicationId: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string', nullable: true },
                isDefault: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'applicationId', 'name', 'isDefault', 'createdAt', 'updatedAt'],
            },
            'The role catalog, default role first then alphabetical.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await endUserRolesService.list(id) };
    },
  );

  app.post(
    '/:id/end-user-roles',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Add a role to the catalog',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 40 },
            description: { type: 'string', maxLength: 240 },
            isDefault: { type: 'boolean' },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                applicationId: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string', nullable: true },
                isDefault: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'applicationId', 'name', 'isDefault', 'createdAt', 'updatedAt'],
            },
            'The created role.',
          ),
          ...errs({
            400: 'END_USER_ROLE_NAME_INVALID — the name is not lowercase letters/digits/hyphens/underscores (2-40 chars, edges alphanumeric).',
            ...APP_WRITE_ERRORS,
            409: 'END_USER_ROLE_NAME_TAKEN — another role on this Application already uses that name.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      // `.strict()` — same rule as the config patches. This route answered 201
      // for keys it dropped, which is how a tester lost an afternoon to
      // `{"allowMagicLink": true}` being "accepted".
      const body = z
        .object({
          name: z.string().min(2).max(40),
          description: z.string().max(240).optional(),
          isDefault: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      const created = await endUserRolesService.create({
        applicationId: id,
        name: body.name,
        ...(body.description !== undefined && { description: body.description }),
        ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
      });
      return reply.status(201).send({ success: true, data: created });
    },
  );

  app.patch(
    '/:id/end-user-roles/:name',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Update a role (description, default flag)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        body: {
          type: 'object',
          properties: {
            description: { type: 'string', maxLength: 240 },
            isDefault: { type: 'boolean' },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                applicationId: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string', nullable: true },
                isDefault: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'applicationId', 'name', 'isDefault', 'createdAt', 'updatedAt'],
            },
            'The patched role.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'END_USER_ROLE_NOT_FOUND — no role with that name on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), name: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      // All-optional patch body → unknown keys are the only thing left to
      // validate. Same rule as auth-config / billing-config / portal / access.
      const body = z
        .object({
          description: z.string().max(240).nullable().optional(),
          isDefault: z.boolean().optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const updated = await endUserRolesService.update({
        applicationId: params.id,
        name: params.name,
        ...(body.description !== undefined && { description: body.description }),
        ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
      });
      return { success: true, data: updated };
    },
  );

  app.delete(
    '/:id/end-user-roles/:name',
    {
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Delete a role; pass ?reassignTo=name to bulk-move users in one transaction',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        querystring: {
          type: 'object',
          properties: { reassignTo: { type: 'string', minLength: 1, maxLength: 40 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                removed: { type: 'boolean', enum: [true] },
                reassigned: { type: 'integer', description: 'End-users moved to `reassignTo`, when passed.' },
              },
              required: ['removed', 'reassigned'],
            },
            'Confirmation of removal.',
          ),
          ...errs({
            400:
              'END_USER_ROLE_IS_DEFAULT — cannot delete the Application\'s default role; or ' +
              'END_USER_ROLE_IN_USE — end-users still hold this role and no `reassignTo` was given; or ' +
              'END_USER_ROLE_REASSIGN_SELF — `reassignTo` names the role being deleted; or ' +
              'END_USER_ROLE_REASSIGN_TARGET_UNKNOWN — `reassignTo` does not exist.',
            ...APP_WRITE_ERRORS,
            404: 'END_USER_ROLE_NOT_FOUND — no role with that name on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), name: z.string().min(1) })
        .parse(req.params);
      const q = z.object({ reassignTo: z.string().min(1).max(40).optional() }).parse(req.query);
      await ensureAppAccess(req, params.id, 'write');
      const result = await endUserRolesService.remove({
        applicationId: params.id,
        name: params.name,
        ...(q.reassignTo !== undefined && { reassignTo: q.reassignTo }),
      });
      return { success: true, data: result };
    },
  );

  // ---------- Licenses (issue + list + revoke) ----------

  app.get(
    '/:id/licenses',
    {
      schema: {
        tags: ['Tenant · Licenses'],
        security: [{ tenantSession: [] }],
        summary: 'List licenses for an Application',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('License'), 'A page of licenses, newest first.'),
          ...errs({ 400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        licensesService.listForApplication(id, { take, skip }),
        licensesService.countForApplication(id),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/licenses',
    {
      // Generic Idempotency-Key header support (scoped to the workspace) — a
      // retried issue would otherwise mint a second license key nobody saw.
      config: { idempotency: true },
      schema: {
        tags: ['Tenant · Licenses'],
        security: [{ tenantSession: [] }],
        summary: 'Issue a license to an end-user',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Returns the raw key in `data.rawKey` — show ONCE. PERPETUAL/TIMED/SEATS kinds. ' +
          'Customer apps validate via POST /api/v1/licenses/verify.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['endUserId', 'kind'],
          properties: {
            endUserId: { type: 'string', minLength: 1 },
            kind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
            planId: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
            seatsAllowed: { type: 'integer', minimum: 1, maximum: 2147483647 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                license: ref('License'),
                rawKey: { type: 'string', description: 'Shown exactly once — store it now.' },
                warning: { type: 'string' },
              },
              required: ['license', 'rawKey', 'warning'],
            },
            'The issued license plus its raw key (shown once).',
          ),
          // NOTE: 404 is declared as its own literal key (not folded into the `errs()` spread
          // below) because the handler calls `reply.status(404)` directly for the cross-app
          // endUserId check — Fastify's typed reply only accepts status codes that appear as
          // literal keys of `schema.response`, and a spread of `errs()`'s Record<number,
          // JsonSchema> return type doesn't preserve individual literals. This branch is also
          // hand-built, bypassing the normal RekeyError path — it omits `requestId`. See the
          // final report.
          404: errs({
            404: 'END_USER_NOT_FOUND — `endUserId` does not belong to this Application. Or ' + APP_WRITE_ERRORS[404],
          })[404],
          ...errs({
            400:
              'LICENSE_EXPIRES_AT_REQUIRED — a TIMED license is missing `expiresAt`; or ' +
              'LICENSE_SEATS_REQUIRED — a SEATS license is missing a valid `seatsAllowed`; or ' +
              'VALIDATION_ERROR — a field failed schema validation.',
            401: APP_WRITE_ERRORS[401],
            403: APP_WRITE_ERRORS[403],
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          endUserId: z.string().min(1),
          kind: z.enum(['PERPETUAL', 'TIMED', 'SEATS']),
          planId: z.string().optional(),
          expiresAt: z.string().datetime().optional(),
          seatsAllowed: positiveBoundedInt().optional(),
          metadata: z.record(z.unknown()).optional(),
        })
        .parse(req.body);
      // Confirm the EndUser belongs to this Application — otherwise we'd
      // accept arbitrary cross-app linking. (Service trusts the caller;
      // we enforce here.)
      const endUser = await prisma.endUser.findUnique({ where: { id: body.endUserId } });
      if (!endUser || endUser.applicationId !== id) {
        // Throw, never hand-build the envelope. A `reply.status(404).send({
        // success: false, error: {...} })` here skipped `rekeyErrorHandler`
        // entirely, so this was the one error response in the whole API with
        // no `requestId` field and no `X-Request-Id` header — the two things
        // a caller needs to get support to find the matching server log.
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `EndUser "${body.endUserId}" not found in this Application.`,
          fix: 'Verify the user id and that they signed up under this Application.',
        });
      }
      const application = await applicationsService.get(id, { tenantId: req.tenantId! });
      const result = await licensesService.issue({
        application,
        endUser,
        kind: body.kind as LicenseKind,
        planId: body.planId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        seatsAllowed: body.seatsAllowed,
        metadata: body.metadata,
      });
      return reply.status(201).send({
        success: true,
        data: {
          license: result.license,
          rawKey: result.rawKey,
          warning:
            'Store this rawKey now — it is shown exactly once and cannot be recovered. The customer\'s software validates against POST /api/v1/licenses/verify.',
        },
      });
    },
  );

  app.delete(
    '/:id/licenses/:licenseId',
    {
      schema: {
        tags: ['Tenant · Licenses'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke a license',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, licenseId: { type: 'string' } },
          required: ['id', 'licenseId'],
        },
        response: {
          200: ok(ref('License'), 'The revoked license. Idempotent — revoking an already-revoked license 200s unchanged.'),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'LICENSE_NOT_FOUND — no license with that id on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, licenseId } = z
        .object({ id: z.string().min(1), licenseId: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const revoked = await licensesService.revoke(id, licenseId);
      return { success: true, data: revoked };
    },
  );

  // ---------- Usage meters ----------

  app.get(
    '/:id/usage-meters',
    {
      schema: {
        tags: ['Tenant · Usage'],
        security: [{ tenantSession: [] }],
        summary: 'List usage meters',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('UsageMeter'), 'A page of usage meters.'),
          ...errs({ 400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        usageService.listMeters(id, { take, skip }),
        usageService.countMeters(id),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/usage-meters',
    {
      schema: {
        tags: ['Tenant · Usage'],
        security: [{ tenantSession: [] }],
        summary: 'Create a usage meter',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        body: {
          type: 'object',
          required: ['slug', 'name', 'unit'],
          properties: {
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            unit: { type: 'string', minLength: 1, maxLength: 40 },
            creditsPerUnit: { type: 'integer', minimum: 0, maximum: 2147483647 },
          },
        },
        response: {
          201: ok(ref('UsageMeter'), 'The created usage meter.'),
          ...errs({
            400: 'USAGE_METER_SLUG_INVALID — the slug is not lowercase alphanumerics + - / _; or VALIDATION_ERROR — a field failed schema validation.',
            ...APP_WRITE_ERRORS,
            409: 'USAGE_METER_SLUG_TAKEN — another meter on this Application already uses that slug.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          slug: z.string().min(1).max(40),
          name: z.string().min(1).max(120),
          unit: z.string().min(1).max(40),
          // Declared in the JSON schema; without it here zod strips the field
          // and the create reports success having stored nothing.
          creditsPerUnit: z.number().int().min(0).max(2_147_483_647).optional(),
        })
        .parse(req.body);
      const meter = await usageService.createMeter({ applicationId: id, ...body });
      return reply.status(201).send({ success: true, data: meter });
    },
  );

  app.patch(
    '/:id/usage-meters/:slug',
    {
      schema: {
        tags: ['Tenant · Usage'],
        security: [{ tenantSession: [] }],
        summary: 'Toggle a usage meter active/inactive',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          '`active` is the ONLY editable field, and it is required. A meter\'s `slug`, ' +
          '`name` and `unit` are fixed at creation — sending them is a 400, not a silent ' +
          'no-op. Delete and recreate the meter to change them.',
        // This body was undeclared, so `/docs/json` published the operation with
        // no requestBody at all while `active` was in fact mandatory — there was
        // no documented way to discover the shape. (Landed on main in #326; this
        // branch had found the same omission independently.)
        body: {
          type: 'object',
          // Neither is required alone; the handler refuses a body that sets
          // neither. `required: ['active']` here rejected a price-only PATCH
          // before the handler was reached.
          properties: {
            active: { type: 'boolean' },
            // null clears the price, returning the meter to counting only.
            creditsPerUnit: { type: 'integer', nullable: true, minimum: 0, maximum: 2147483647 },
          },
        },
        response: {
          200: ok(ref('UsageMeter'), 'The meter, with `active` and/or `creditsPerUnit` updated.'),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'USAGE_METER_NOT_FOUND — no meter with that slug on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = z
        .object({ id: z.string().min(1), slug: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, id, 'write');
      // `.strict()`. This route is `setActive` and nothing else, but it used to
      // accept `{"name":"RENAMED","unit":"widget","active":true}`, apply only
      // `active`, and answer 200 echoing the PRE-EDIT row — so the response the
      // caller got back was itself the evidence that nothing happened, and read
      // as if it had. Worse than the auth-config case: `name` and `unit` are the
      // object's OWN fields, not unrecognised ones.
      //
      // Rejecting rather than implementing rename is deliberate. `slug` is what
      // `Plan.meterSlug` binds against, and `unit` is the label every usage
      // record ALREADY WRITTEN was measured in — retitling a meter silently
      // relabels history. That is a product decision, not something to smuggle
      // into an endpoint whose summary is "toggle"; see decisions.md.
      // Still `.strict()`: an unknown key is a caller bug, not something to
      // ignore. Both fields optional, at least one required — a PATCH that
      // says nothing is a mistake worth naming.
      const body = z
        .object({
          active: z.boolean().optional(),
          creditsPerUnit: z.number().int().min(0).nullable().optional(),
        })
        .strict()
        .refine((b) => b.active !== undefined || b.creditsPerUnit !== undefined, {
          message: 'Provide `active`, `creditsPerUnit`, or both.',
        })
        .parse(req.body ?? {});

      let meter;
      if (body.creditsPerUnit !== undefined) {
        meter = await usageService.setPrice(id, slug, body.creditsPerUnit);
      }
      if (body.active !== undefined) {
        meter = await usageService.setActive(id, slug, body.active);
      }
      return { success: true, data: meter };
    },
  );

  app.delete(
    '/:id/usage-meters/:slug',
    {
      schema: {
        tags: ['Tenant · Usage'],
        security: [{ tenantSession: [] }],
        summary: 'Permanently delete a usage meter (cascades to records)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(
            { type: 'object', properties: { removed: { type: 'boolean', enum: [true] } }, required: ['removed'] },
            'Confirmation. The meter and its usage records were deleted.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'USAGE_METER_NOT_FOUND — no meter with that slug on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = z
        .object({ id: z.string().min(1), slug: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await usageService.remove(id, slug);
      return { success: true, data: { removed: true } };
    },
  );

  // ---------- Organizations (end-user teams) ----------
  //
  // Read + moderation surface over the end-user Organization model. End-users
  // create/manage their own orgs through /api/v1/users/me/organizations (the
  // SDK); these operator routes give the panel visibility and a delete for
  // cleanup. Not gated by authConfig.organizationsEnabled — operators can
  // still inspect orgs created before the feature was toggled off.

  app.get(
    '/:id/organizations',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'List end-user organizations in this Application',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                slug: { type: 'string' },
                metadata: { type: 'object', nullable: true, additionalProperties: true },
                memberCount: { type: 'integer' },
                pendingInvitationCount: { type: 'integer' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'name', 'slug', 'memberCount', 'pendingInvitationCount', 'createdAt', 'updatedAt'],
            },
            'A page of end-user organizations.',
          ),
          ...errs({ 400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.', ...APP_READ_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [rows, total] = await Promise.all([
        organizationsService.adminList({ applicationId: id, take, skip }),
        organizationsService.adminCount({ applicationId: id }),
      ]);
      return {
        success: true,
        data: paged(
          rows.map((o) => ({
            id: o.id,
            name: o.name,
            slug: o.slug,
            metadata: o.metadata ?? null,
            memberCount: o.memberCount,
            pendingInvitationCount: o.pendingInvitationCount,
            createdAt: o.createdAt.toISOString(),
            updatedAt: o.updatedAt.toISOString(),
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.get(
    '/:id/organizations/:orgId',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Get one organization with its members + pending invitations',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' } },
          required: ['id', 'orgId'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                organization: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    slug: { type: 'string' },
                    metadata: { type: 'object', nullable: true, additionalProperties: true },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                  required: ['id', 'name', 'slug', 'createdAt', 'updatedAt'],
                },
                members: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      endUserId: { type: 'string' },
                      email: { type: 'string', format: 'email' },
                      role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                    required: ['id', 'endUserId', 'email', 'role', 'createdAt'],
                  },
                },
                invitations: {
                  type: 'array',
                  description: 'Pending (unaccepted, unrevoked) invitations.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      email: { type: 'string', format: 'email' },
                      role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
                      expiresAt: { type: 'string', format: 'date-time' },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                    required: ['id', 'email', 'role', 'expiresAt', 'createdAt'],
                  },
                },
              },
              required: ['organization', 'members', 'invitations'],
            },
            'The organization plus its members and pending invitations.',
          ),
          ...errs({
            ...APP_READ_ERRORS,
            404: 'ORGANIZATION_NOT_FOUND — no organization with that id on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1), orgId: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'read');
      const r = await organizationsService.adminGet({
        applicationId: params.id,
        organizationId: params.orgId,
      });
      return {
        success: true,
        data: {
          organization: {
            id: r.organization.id,
            name: r.organization.name,
            slug: r.organization.slug,
            metadata: r.organization.metadata ?? null,
            createdAt: r.organization.createdAt.toISOString(),
            updatedAt: r.organization.updatedAt.toISOString(),
          },
          members: r.members.map((m) => ({
            id: m.id,
            endUserId: m.endUserId,
            email: m.email,
            role: m.role,
            createdAt: m.createdAt.toISOString(),
          })),
          invitations: r.invitations.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            expiresAt: i.expiresAt.toISOString(),
            createdAt: i.createdAt.toISOString(),
          })),
        },
      };
    },
  );

  app.delete(
    '/:id/organizations/:orgId',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Delete an organization (cascades to memberships + invitations)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' } },
          required: ['id', 'orgId'],
        },
        response: {
          200: ok(
            { type: 'object', properties: { deleted: { type: 'boolean', enum: [true] } }, required: ['deleted'] },
            'Confirmation.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'ORGANIZATION_NOT_FOUND — no organization with that id on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1), orgId: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const data = await organizationsService.adminDelete({
        applicationId: params.id,
        organizationId: params.orgId,
      });
      return { success: true, data };
    },
  );

  // Operator-driven org management (create + member CRUD). End-users still
  // self-serve via the SDK; these let an operator provision/curate orgs and
  // memberships directly. No org role-hierarchy check — the operator is the
  // app administrator.

  app.post(
    '/:id/organizations',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Create an organization (optionally seed an initial OWNER)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            metadata: { type: 'object', additionalProperties: true },
            ownerEndUserId: { type: 'string', minLength: 1 },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                slug: { type: 'string' },
                metadata: { type: 'object', nullable: true, additionalProperties: true },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'name', 'slug', 'createdAt', 'updatedAt'],
            },
            'The created organization.',
          ),
          ...errs({
            400: 'ORGANIZATION_SLUG_INVALID — the slug is not 1-40 chars of [a-z0-9-]; or VALIDATION_ERROR — a field failed schema validation.',
            ...APP_WRITE_ERRORS,
            404: 'END_USER_NOT_FOUND — `ownerEndUserId` does not belong to this Application.',
            409: 'ORGANIZATION_SLUG_TAKEN — another organization on this Application already uses that slug.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          name: z.string().min(1).max(120),
          slug: z.string().min(1).max(40),
          metadata: z.record(z.unknown()).optional(),
          ownerEndUserId: z.string().min(1).optional(),
        })
        .parse(req.body);
      const org = await organizationsService.adminCreate({
        applicationId: id,
        name: body.name,
        slug: body.slug,
        ...(body.metadata !== undefined && { metadata: body.metadata }),
        ...(body.ownerEndUserId !== undefined && { ownerEndUserId: body.ownerEndUserId }),
      });
      return reply.status(201).send({
        success: true,
        data: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          metadata: org.metadata ?? null,
          createdAt: org.createdAt.toISOString(),
          updatedAt: org.updatedAt.toISOString(),
        },
      });
    },
  );

  app.patch(
    '/:id/organizations/:orgId',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Update an organization (name / metadata)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' } },
          required: ['id', 'orgId'],
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                slug: { type: 'string' },
                metadata: { type: 'object', nullable: true, additionalProperties: true },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'name', 'slug', 'createdAt', 'updatedAt'],
            },
            'The patched organization.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'ORGANIZATION_NOT_FOUND — no organization with that id on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1), orgId: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const body = z
        .object({
          name: z.string().min(1).max(120).optional(),
          metadata: z.record(z.unknown()).optional(),
        })
        .parse(req.body);
      const org = await organizationsService.adminUpdate({
        applicationId: params.id,
        organizationId: params.orgId,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return {
        success: true,
        data: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          metadata: org.metadata ?? null,
          createdAt: org.createdAt.toISOString(),
          updatedAt: org.updatedAt.toISOString(),
        },
      };
    },
  );

  app.post(
    '/:id/organizations/:orgId/members',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Add an existing end-user to an organization with a role',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' } },
          required: ['id', 'orgId'],
        },
        body: {
          type: 'object',
          required: ['endUserId', 'role'],
          properties: {
            endUserId: { type: 'string', minLength: 1 },
            role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                organizationId: { type: 'string' },
                endUserId: { type: 'string' },
                email: { type: 'string', format: 'email' },
                role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'organizationId', 'endUserId', 'email', 'role', 'createdAt'],
            },
            'The created membership.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404:
              'ORGANIZATION_NOT_FOUND — no organization with that id on this Application; or ' +
              'END_USER_NOT_FOUND — `endUserId` does not belong to this Application.',
            409: 'ORGANIZATION_ALREADY_MEMBER — that end-user is already a member of this organization.',
          }),
        },
      },
    },
    async (req, reply) => {
      const params = z.object({ id: z.string().min(1), orgId: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const body = z
        .object({ endUserId: z.string().min(1), role: z.enum(['OWNER', 'ADMIN', 'MEMBER']) })
        .parse(req.body);
      const m = await organizationsService.adminAddMember({
        applicationId: params.id,
        organizationId: params.orgId,
        endUserId: body.endUserId,
        role: body.role,
      });
      return reply.status(201).send({
        success: true,
        data: {
          id: m.id,
          organizationId: m.organizationId,
          endUserId: m.endUserId,
          email: m.email,
          role: m.role,
          createdAt: m.createdAt.toISOString(),
        },
      });
    },
  );

  app.patch(
    '/:id/organizations/:orgId/members/:euid',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: "Change an organization member's role",
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' }, euid: { type: 'string' } },
          required: ['id', 'orgId', 'euid'],
        },
        body: {
          type: 'object',
          required: ['role'],
          properties: { role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                organizationId: { type: 'string' },
                endUserId: { type: 'string' },
                role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['id', 'organizationId', 'endUserId', 'role', 'createdAt'],
            },
            'The membership, with `role` updated.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404:
              'ORGANIZATION_NOT_FOUND — no organization with that id on this Application; or ' +
              'ORGANIZATION_MEMBER_NOT_FOUND — that end-user is not a member of this organization.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), orgId: z.string().min(1), euid: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const body = z.object({ role: z.enum(['OWNER', 'ADMIN', 'MEMBER']) }).parse(req.body);
      const m = await organizationsService.adminSetMemberRole({
        applicationId: params.id,
        organizationId: params.orgId,
        endUserId: params.euid,
        role: body.role,
      });
      return {
        success: true,
        data: {
          id: m.id,
          organizationId: m.organizationId,
          endUserId: m.endUserId,
          role: m.role,
          createdAt: m.createdAt.toISOString(),
        },
      };
    },
  );

  app.delete(
    '/:id/organizations/:orgId/members/:euid',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Remove an end-user from an organization',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' }, euid: { type: 'string' } },
          required: ['id', 'orgId', 'euid'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                removed: { type: 'boolean', description: 'False when the end-user was already not a member (idempotent).' },
              },
              required: ['removed'],
            },
            'Confirmation.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: 'ORGANIZATION_NOT_FOUND — no organization with that id on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), orgId: z.string().min(1), euid: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const data = await organizationsService.adminRemoveMember({
        applicationId: params.id,
        organizationId: params.orgId,
        endUserId: params.euid,
      });
      return { success: true, data };
    },
  );

  // Org billing (owner+beneficiary): the org's entitlements + shared credit
  // pool + the subscriptions whose beneficiary is this org.
  app.get(
    '/:id/organizations/:orgId/billing',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Org billing summary — entitlements, shared credit pool, beneficiary subscriptions',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' } },
          required: ['id', 'orgId'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                creditBalance: { type: 'integer' },
                features: {
                  type: 'object',
                  description: 'Resolved FEATURE entitlements as key → typed value.',
                  additionalProperties: true,
                },
                entitlements: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['FEATURE', 'CREDIT', 'LICENSE', 'USAGE'] },
                      key: { type: 'string' },
                      valueType: { type: 'string', enum: ['BOOL', 'INT', 'STRING'], nullable: true },
                      value: { type: 'string', nullable: true },
                      quantity: { type: 'integer', nullable: true },
                      licenseKind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'], nullable: true },
                      rollover: { type: 'boolean' },
                    },
                    required: ['kind', 'key', 'rollover'],
                  },
                },
                subscriptions: {
                  type: 'array',
                  description: 'Most recent 100 subscriptions whose beneficiary is this org.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      planSlug: { type: 'string' },
                      planName: { type: 'string' },
                      status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] },
                      ownerEndUserId: { type: 'string' },
                      currentPeriodEnd: { type: 'string', format: 'date-time', nullable: true },
                    },
                    required: ['id', 'planSlug', 'planName', 'status', 'ownerEndUserId'],
                  },
                },
                licenses: {
                  type: 'array',
                  description: 'Org-pooled licenses (most recent 100).',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      kind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
                      status: { type: 'string' },
                      keyPrefix: { type: 'string' },
                      seatsAllowed: { type: 'integer', nullable: true },
                      ownerEndUserId: { type: 'string', nullable: true },
                      expiresAt: { type: 'string', format: 'date-time', nullable: true },
                    },
                    required: ['id', 'kind', 'status', 'keyPrefix'],
                  },
                },
              },
              required: ['creditBalance', 'features', 'entitlements', 'subscriptions', 'licenses'],
            },
            "The org's resolved entitlements, shared credit pool, and beneficiary subscriptions/licenses.",
          ),
          ...errs({
            ...APP_READ_ERRORS,
            404: 'ORGANIZATION_NOT_FOUND — no organization with that id on this Application.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1), orgId: z.string().min(1) }).parse(req.params);
      await ensureAppAccess(req, params.id, 'read');
      await organizationsService.adminLoadOrThrow({ applicationId: params.id, organizationId: params.orgId });
      const resolved = await entitlementsService.resolveForOrg(params.id, params.orgId);
      const [subs, licenses] = await Promise.all([
        prisma.subscription.findMany({
          where: { applicationId: params.id, beneficiaryOrgId: params.orgId },
          include: { plan: { select: { slug: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        licensesService.listForOrganization(params.id, params.orgId),
      ]);
      return {
        success: true,
        data: {
          creditBalance: resolved.creditBalance,
          features: resolved.features,
          entitlements: resolved.entitlements,
          subscriptions: subs.map((s) => ({
            id: s.id,
            planSlug: s.plan.slug,
            planName: s.plan.name,
            status: s.status,
            ownerEndUserId: s.endUserId,
            currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
          })),
          // Seats pooled to the org (shared by the team's machines).
          licenses: licenses.map((l) => ({
            id: l.id,
            kind: l.kind,
            status: l.status,
            keyPrefix: l.keyPrefix,
            seatsAllowed: l.seatsAllowed,
            ownerEndUserId: l.endUserId,
            expiresAt: l.expiresAt?.toISOString() ?? null,
          })),
        },
      };
    },
  );

  // Deliver an org-pooled license key (owner+beneficiary).
  //
  // A license provisioned for an org beneficiary (entitlements.service
  // `provision`) is stored hash-only — the raw key auto-issued at provision
  // time is discarded and, by design, can never be read back. That left the
  // org's seats provisionable but unusable: nobody could obtain a key to call
  // POST /api/v1/licenses/verify. This route mints a FRESH key for the existing
  // pooled license row and returns it ONCE (same hash-only posture as issuance
  // + API keys). Operator-gated: tenant session + `ensureAppAccess(…, 'write')`,
  // so OWNER/ADMIN or a MEMBER holding an APP_ADMIN grant on this Application —
  // there is no extra `requireTenantRole` here. It does not add any
  // end-user-facing reveal surface. Rotating invalidates any prior
  // activations; `activationsReset` lets the operator warn the team if a key
  // was already in circulation (normally 0 — the original was never delivered).
  app.post(
    '/:id/organizations/:orgId/licenses/:licenseId/rotate-key',
    {
      schema: {
        tags: ['Tenant · Organizations'],
        security: [{ tenantSession: [] }],
        summary: 'Mint + reveal the raw key for an org-pooled license (shown once)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Org-pooled license keys are issued during provisioning and stored hash-only, so the ' +
          'raw key is never readable afterwards. This mints a NEW key for the existing pooled ' +
          'license and returns it in `data.rawKey` — show ONCE. Use it to hand the org its key ' +
          'so the team can validate via POST /api/v1/licenses/verify. Rotating resets the key ' +
          'hash and clears existing activations (`data.activationsReset`).',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            orgId: { type: 'string' },
            licenseId: { type: 'string' },
          },
          required: ['id', 'orgId', 'licenseId'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                license: ref('License'),
                rawKey: { type: 'string', description: 'Shown exactly once — store it now.' },
                activationsReset: { type: 'integer', description: 'Prior activations invalidated by the rotation.' },
                warning: { type: 'string' },
              },
              required: ['license', 'rawKey', 'activationsReset', 'warning'],
            },
            'The rotated org-pooled license plus its fresh raw key (shown once).',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404:
              'ORGANIZATION_NOT_FOUND — no organization with that id on this Application; or ' +
              'LICENSE_NOT_FOUND — no such license pooled to this organization.',
            409: 'LICENSE_REVOKED — cannot rotate the key of a revoked license.',
          }),
        },
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), orgId: z.string().min(1), licenseId: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      await organizationsService.adminLoadOrThrow({ applicationId: params.id, organizationId: params.orgId });
      const result = await licensesService.rotateKeyForOrganization(
        params.id,
        params.orgId,
        params.licenseId,
      );
      void recordSecurityEvent({
        type: 'license.org_key_rotated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: params.id,
        ...requestContext(req),
        metadata: {
          organizationId: params.orgId,
          licenseId: params.licenseId,
          activationsReset: result.activationsReset,
        },
      });
      return {
        success: true,
        data: {
          license: result.license,
          rawKey: result.rawKey,
          activationsReset: result.activationsReset,
          warning:
            'Store this rawKey now — it is shown exactly once and cannot be recovered. Hand it to ' +
            "the organization; the team's machines validate against POST /api/v1/licenses/verify.",
        },
      };
    },
  );
}
