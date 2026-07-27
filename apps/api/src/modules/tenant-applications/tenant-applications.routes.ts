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
import { plansService } from '../plans/plans.service.js';
import { couponsService } from '../coupons/coupons.service.js';
import {
  billingCredentialsService,
  type BillingProviderName,
} from '../billing/credentials.service.js';
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
import { PaginationQuery, parsePagination, paginationJsonSchema } from '../../lib/pagination.js';
import { listApiRequests } from '../../lib/request-log.js';
import { CouponDiscountType, type LicenseKind } from '@prisma/client';
import { BillingProviderSchema, GrantCreditsRequestSchema } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import { hashPassword } from '../../lib/passwords.js';
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
} from '../../lib/app-access.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { refreshCorsOrigins } from '../../lib/cors-origins.js';
import { mcpIssuer } from '../mcp/oauth.service.js';
import { eraseEndUser } from './end-user-erasure.service.js';
import { billingService } from '../billing/billing.service.js';
import { webhookService } from '../webhooks/webhook.service.js';

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

// ---- request shapes (mirror the admin routes) ----

const AppParam = z.object({ id: z.string().min(1) });
const KeyIdParam = z.object({ id: z.string().min(1), keyId: z.string().min(1) });
const PlanSlugParam = z.object({ id: z.string().min(1), slug: z.string().min(1) });
const CouponCodeParam = z.object({ id: z.string().min(1), code: z.string().min(1) });

const CreateAppBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(40),
  billingProvider: BillingProviderSchema.optional(),
  enableBilling: z.boolean().optional(),
});

const CreateKeyBody = z.object({
  name: z.string().min(1).max(120),
  mode: z.enum(['live', 'test']).default('live'),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});

const CreatePlanBody = z.object({
  slug: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  amount: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  kind: z.enum(['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT']).optional(),
  licenseKind: z.enum(['PERPETUAL', 'TIMED', 'SEATS']).optional(),
  licenseSeatsAllowed: z.number().int().positive().optional(),
  licenseDurationDays: z.number().int().positive().optional(),
  meterSlug: z.string().min(1).max(40).optional(),
  pricePerUnitCents: z.number().int().min(0).optional(),
  creditsAmount: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const PlanActiveBody = z.object({ active: z.boolean() });

const CreateCouponBody = z.object({
  code: z.string().min(1).max(40),
  discountType: z.enum(['PERCENT', 'AMOUNT']),
  amountOff: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  planSlugs: z.array(z.string().min(1).max(40)).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  maxRedemptions: z.number().int().min(1).optional(),
  maxRedemptionsPerUser: z.number().int().min(1).optional(),
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
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      // MEMBERs with per-app grants only see their granted Applications —
      // this single filter also scopes the panel sidebar + command palette,
      // which are both fed by this endpoint.
      const scope = await appAccessScope(req);
      const apps = await applicationsService.list(req.tenantId!, {
        take,
        skip,
        ...(scope.restricted && { ids: scope.applicationIds }),
      });
      return {
        success: true,
        data: apps.map((a) =>
          scope.roleByApplicationId.get(a.id) === 'APP_BILLING'
            ? redactApplicationForBilling(a)
            : a,
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      const access = await ensureAppAccess(req, id, 'read');
      const application = await applicationsService.get(id);
      // Surface the PUBLIC MCP URL (derived from PUBLIC_WEBHOOK_BASE_URL/API_URL
      // on the API side) so the panel shows the externally-reachable host, not
      // its own in-cluster RELIPAY_URL (e.g. http://api:3030).
      const data = { ...application, mcpUrl: mcpIssuer(application.slug) };
      // Billing managers see money, not sign-in: hide the auth/OAuth config.
      return {
        success: true,
        data: access.level === 'APP_BILLING' ? redactApplicationForBilling(data) : data,
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
          'End-user totals + 30-day sign-up trend, security-events summary, billing snapshot, ' +
          'and a usage/credits roll-up. Scoped to the active workspace.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const requests = await listApiRequests({ applicationId: id, take, skip });
      return { success: true, data: { requests } };
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
          'Requires the **OWNER or ADMIN** workspace role.',
        body: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            billingProvider: { type: 'string', enum: registryNames },
            enableBilling: {
              type: 'boolean',
              description: 'Create with the billing surface enabled. Defaults false.',
            },
          },
        },
      },
    },
    async (req, reply) => {
      const body = CreateAppBody.parse(req.body);
      const created = await applicationsService.create({
        tenantId: req.tenantId!,
        name: body.name,
        slug: body.slug,
        ...(body.billingProvider !== undefined && { billingProvider: body.billingProvider }),
        ...(body.enableBilling !== undefined && { enableBilling: body.enableBilling }),
      });
      return reply.status(201).send({ success: true, data: created });
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
            organizationsEnabled: { type: 'boolean' },
            passwordBreachCheckEnabled: { type: 'boolean', description: 'HIBP Pwned-Passwords breach check at sign-up/reset/change. Default true.' },
            signupEnabled: { type: 'boolean', description: 'Legacy alias for signupMode (false ⇔ invite_only). Prefer signupMode.' },
            signupMode: {
              type: 'string',
              enum: ['public', 'secret_only', 'invite_only'],
              description:
                'Who may create end-users: public (any key), secret_only (server-side secret key only — publishable key refused with SIGNUP_REQUIRES_SECRET_KEY), or invite_only (no public sign-up).',
            },
            mfa: { type: 'string', enum: ['off', 'optional', 'required'], description: 'End-user 2FA policy.' },
            mcpEnabled: { type: 'boolean', description: 'Expose a hosted MCP server + OAuth AS for this app.' },
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
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          methods: z.array(z.string().min(1).max(40)).optional(),
          passwordMinLength: z.number().int().min(8).max(128).optional(),
          redirectUrls: z.array(z.string().url()).optional(),
          organizationsEnabled: z.boolean().optional(),
          passwordBreachCheckEnabled: z.boolean().optional(),
          signupEnabled: z.boolean().optional(),
          signupMode: z.enum(['public', 'secret_only', 'invite_only']).optional(),
          mfa: z.enum(['off', 'optional', 'required']).optional(),
          mcpEnabled: z.boolean().optional(),
          tokenAlg: z.enum(['HS256', 'RS256']).optional(),
        })
        .parse(req.body);
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
              type: ['string', 'null'],
              description:
                'Free-tier fallback. Slug of an active plan whose FEATURE flags + included usage quota apply to end-users with no active subscription. null clears it.',
            },
          },
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          enabled: z.boolean().optional(),
          dunningEnabled: z.boolean().optional(),
          billingSubject: z.enum(['user', 'org']).optional(),
          defaultPlanSlug: z.string().min(1).nullable().optional(),
        })
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
          '`APP_ADMIN` grant on it.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            mode: { type: 'string', enum: ['live', 'test'], default: 'live' },
            scopes: { type: 'array', items: { type: 'string' } },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = CreateKeyBody.parse(req.body);
      // Test-mode API keys are paused pending a review of the test/live model.
      // Billing keeps its own test mode; only API-key minting is gated here.
      // Remove this guard (and re-expose the option in the panel) to restore it.
      if (body.mode === 'test') {
        throw new RekeyError({
          statusCode: 400,
          code: 'TEST_API_KEYS_DISABLED',
          message: 'Test-mode API keys are temporarily disabled.',
          fix: 'Mint a live key (rp_live_…). Billing still supports test mode separately.',
        });
      }
      const result = await apiKeysService.create({
        applicationId: id,
        name: body.name,
        mode: body.mode,
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
        metadata: { apiKeyId: result.apiKey.id, name: body.name, mode: body.mode, scopes: body.scopes },
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      return { success: true, data: await plansService.listForApplication(id, true, { take, skip }) };
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
            amount: { type: 'integer', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            interval: { type: 'string', enum: ['MONTH', 'YEAR'] },
            kind: { type: 'string', enum: ['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT'] },
            licenseKind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
            licenseSeatsAllowed: { type: 'integer', minimum: 1 },
            licenseDurationDays: { type: 'integer', minimum: 1 },
            meterSlug: { type: 'string', minLength: 1, maxLength: 40 },
            pricePerUnitCents: { type: 'integer', minimum: 0 },
            creditsAmount: { type: 'integer', minimum: 1 },
            metadata: { type: 'object', additionalProperties: true },
          },
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
        summary: 'Toggle a Plan\'s active flag',
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
          required: ['active'],
          properties: { active: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const { id, slug } = PlanSlugParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const body = PlanActiveBody.parse(req.body);
      const updated = await plansService.setActive(id, slug, body.active);
      void recordSecurityEvent({
        type: 'app.plan_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { slug, active: body.active },
      });
      return { success: true, data: updated };
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' } },
          required: ['id', 'slug'],
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
            quantity: { type: 'integer' },
            licenseKind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
            rollover: { type: 'boolean' },
          },
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
          quantity: z.number().int().optional(),
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
          'Each coupon carries `redemptionCount` and `totalDiscountIssued` (smallest ' +
          'currency unit) aggregated from the redemptions table.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      return { success: true, data: await couponsService.listWithStats(id, true, { take, skip }) };
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
            amountOff: { type: 'integer', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            planSlugs: { type: 'array', items: { type: 'string' } },
            startsAt: { type: 'string', format: 'date-time' },
            endsAt: { type: 'string', format: 'date-time' },
            maxRedemptions: { type: 'integer', minimum: 1 },
            maxRedemptionsPerUser: { type: 'integer', minimum: 1 },
          },
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
          'One entry per REGISTERED provider module (in registry order), whether or not this ' +
          'Application has configured it: display metadata (label, docs URL, default countries, ' +
          'priority), capabilities, and the credential field schema the panel renders forms from. ' +
          '`status` is null until the provider is configured for this Application. ' +
          'Never returns credential values — those are write-only.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
          'Returns one entry per configured provider with its enabled flag, country list, and priority. ' +
          'Never returns the credentials themselves — those are write-only.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string(), provider: providerNameSchema })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const application = await applicationsService.get(params.id);
      const result = await billingCredentialsService.registerWebhook(
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
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
      const events = await prisma.webhookEvent.findMany({
        where: { applicationId: params.id, ...(query.provider ? { provider: query.provider } : {}) },
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
      });
      return {
        success: true,
        data: events.map((e) => ({
          ...e,
          // processed cleanly → ok; recorded but errored → error; not yet processed → received.
          status: e.processingError ? 'error' : e.processedAt ? 'processed' : 'received',
          receivedAt: e.receivedAt.toISOString(),
          processedAt: e.processedAt?.toISOString() ?? null,
        })),
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
          'Subscription counters (active, past-due, canceled/new in the last 30 days), MRR ' +
          '(ACTIVE recurring SUBSCRIPTION plans, yearly normalized to monthly), 30-day payment ' +
          'volume + success/failure counts, and a 12-month UTC monthly revenue series. ' +
          'All amounts are in the smallest currency unit. Live-mode data only — TEST ' +
          'subscriptions/payments (sandbox checkouts via rp_test_* keys) are excluded.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
          'Operator view of every Payment row — subscription invoices and one-time charges. ' +
          'Filter by `status`, a `from`/`to` createdAt window, and `mode` (TEST/LIVE — operator ' +
          'surfaces see both modes by default; rows carry `mode`). Joined with the paying ' +
          "end-user's email where the payment is attributable to one. " +
          'Sort with `?sort=createdAt|amount|status&order=asc|desc` (default createdAt desc).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] },
            mode: { type: 'string', enum: ['TEST', 'LIVE'] },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            sort: { type: 'string', enum: ['createdAt', 'amount', 'status'] },
            order: { type: 'string', enum: ['asc', 'desc'] },
            ...paginationJsonSchema,
          },
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const q = z
        .object({
          status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']).optional(),
          mode: z.enum(['TEST', 'LIVE']).optional(),
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
      const payments = await prisma.payment.findMany({
        where: {
          applicationId: id,
          ...(q.status && { status: q.status }),
          ...(q.mode && { mode: q.mode }),
          ...((q.from || q.to) && {
            createdAt: {
              ...(q.from && { gte: q.from }),
              ...(q.to && { lte: q.to }),
            },
          }),
        },
        select: {
          id: true,
          endUserId: true,
          subscriptionId: true,
          amount: true,
          currency: true,
          status: true,
          mode: true,
          providerPaymentId: true,
          description: true,
          createdAt: true,
        },
        // Stable secondary order by id so pages never overlap/skip when many
        // rows share the same sort value (e.g. equal amounts).
        orderBy: [primaryOrder, { id: 'desc' }],
        take,
        skip,
      });
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
        data: payments.map((p) => ({
          ...p,
          endUserEmail: p.endUserId ? (emailById.get(p.endUserId) ?? null) : null,
          createdAt: p.createdAt.toISOString(),
        })),
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
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
      const cases = await prisma.dunningCase.findMany({
        where: { applicationId: id, ...(q.status && { status: q.status }) },
        include: { subscription: { select: { mode: true, plan: { select: { slug: true, name: true } } } } },
        // Stable secondary order by id so pages never overlap/skip.
        orderBy: [primaryOrder, { id: 'desc' }],
        take,
        skip,
      });
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
        data: cases.map((c) => ({
          id: c.id,
          subscriptionId: c.subscriptionId,
          endUserId: c.endUserId,
          endUserEmail: c.endUserId ? (emailById.get(c.endUserId) ?? null) : null,
          organizationId: c.organizationId,
          status: c.status,
          mode: c.subscription.mode,
          planSlug: c.subscription.plan.slug,
          planName: c.subscription.plan.name,
          failedAttempts: c.failedAttempts,
          remindersSent: c.remindersSent,
          lastFailureAt: c.lastFailureAt?.toISOString() ?? null,
          nextActionAt: c.nextActionAt?.toISOString() ?? null,
          openedAt: c.openedAt.toISOString(),
          closedAt: c.closedAt?.toISOString() ?? null,
        })),
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
          'any grant on it (grant-less legacy members keep workspace-wide read).\n\n' +
          'Sort with `?sort=createdAt|email&order=asc|desc` (default createdAt desc). ' +
          'Rows carry `mode` (TEST = signed up via an rp_test_* key); operator surfaces see ' +
          'both modes by default — filter with `?mode=TEST|LIVE`.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', maxLength: 254 },
            emailVerified: { type: 'boolean' },
            mode: { type: 'string', enum: ['TEST', 'LIVE'] },
            subscriptionStatus: {
              type: 'string',
              enum: ['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'],
            },
            sort: { type: 'string', enum: ['createdAt', 'email'] },
            order: { type: 'string', enum: ['asc', 'desc'] },
            ...paginationJsonSchema,
          },
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
          mode: z.enum(['TEST', 'LIVE']).optional(),
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
      const users = await prisma.endUser.findMany({
        where: {
          applicationId: id,
          ...(q.search && { email: { contains: q.search.toLowerCase() } }),
          ...(q.emailVerified !== undefined && { emailVerified: q.emailVerified }),
          ...(q.mode && { mode: q.mode }),
          ...(q.subscriptionStatus && {
            subscriptions: { some: { status: q.subscriptionStatus } },
          }),
        },
        // Stable secondary order by id keeps pagination consistent on ties.
        orderBy: [q.sort === 'email' ? { email: order } : { createdAt: order }, { id: 'desc' }],
        take,
        skip,
        select: {
          id: true, email: true, emailVerified: true, role: true, mode: true, metadata: true, createdAt: true,
        },
      });
      return { success: true, data: users };
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
          return reply.status(409).send({
            success: false,
            error: {
              code: 'EMAIL_ALREADY_EXISTS',
              message: 'An end-user with that email already exists in this Application.',
              fix: 'Pick a different email or use the existing user.',
            },
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
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
          mode: true,
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
      const [passkeys, recentImpersonations] = await Promise.all([
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
      ]);
      return {
        success: true,
        data: {
          endUser: eu,
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
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
      void webhookService
        .emit({
          applicationId: params.id,
          type: 'user.deleted',
          data: { user: { id: params.euid } },
        })
        .catch(() => undefined);

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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
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
            amount: { type: 'integer' },
            reason: { type: 'string', enum: ['GRANT', 'REFUND', 'ADJUST'] },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
            metadata: { type: 'object', additionalProperties: true },
          },
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
          failedSignInAttempts: true,
          lockedUntil: true,
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
          lockedUntil: endUser.lockedUntil?.toISOString() ?? null,
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
  // carries `imp = <operator user id>` alongside the normal `sub`
  // (end-user id). The operator's customer-facing service uses this token
  // exactly like a real session token — every route the user could call
  // becomes callable as them, except routes that explicitly refuse
  // impersonation (none today, but `claims.imp` is the seam to add such
  // checks). Bounded lifetime + no refresh + durable audit row.
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
      const minted = issueImpersonationToken(
        endUser.id,
        endUser.applicationId,
        req.tenantUser!.id,
        impApp.tokenGeneration,
      );
      const ua = req.headers['user-agent'];
      await prisma.impersonationAudit.create({
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
      return {
        success: true,
        data: {
          accessToken: minted.token,
          accessTokenExpiresAt: minted.expiresAt.toISOString(),
          impersonatedUser: {
            id: endUser.id,
            email: endUser.email,
            role: endUser.role,
          },
          warning:
            'This token expires in 5 minutes and has NO refresh. Every action taken with it is recorded with the `imp` claim pointing at your operator id.',
        },
      };
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
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Rotate the publishable key (dual-key grace window)',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.\n\n' +
          'Mints a new rp_pub_ key and keeps the old one valid for `graceDays` (default 30, ' +
          'max 90) so clients shipped with the old key keep working until you redeploy. ' +
          'Roll the new key out to your frontends/installs during the window.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            graceDays: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
            force: { type: 'boolean', default: false },
          },
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
  // portal.relipay.dev/<slug>, and set its branding. Enabling auto-allows the
  // portal origin for this app's publishable key. OWNER/ADMIN.
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
  });
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

  // ---------- Network access controls (IP allowlist + per-app CORS) ----------

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
  });

  app.get(
    '/:id/access',
    {
      schema: {
        tags: ['Tenant · Applications'],
        security: [{ tenantSession: [] }],
        summary: 'Get the Application IP allowlist + CORS origins',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
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
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          name: z.string().min(2).max(40),
          description: z.string().max(240).optional(),
          isDefault: z.boolean().optional(),
        })
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
      },
    },
    async (req) => {
      const params = z
        .object({ id: z.string().min(1), name: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, params.id, 'write');
      const body = z
        .object({
          description: z.string().max(240).nullable().optional(),
          isDefault: z.boolean().optional(),
        })
        .parse(req.body);
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      return { success: true, data: await licensesService.listForApplication(id, { take, skip }) };
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
            seatsAllowed: { type: 'integer', minimum: 1 },
            metadata: { type: 'object', additionalProperties: true },
          },
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
          seatsAllowed: z.number().int().min(1).optional(),
          metadata: z.record(z.unknown()).optional(),
        })
        .parse(req.body);
      // Confirm the EndUser belongs to this Application — otherwise we'd
      // accept arbitrary cross-app linking. (Service trusts the caller;
      // we enforce here.)
      const endUser = await prisma.endUser.findUnique({ where: { id: body.endUserId } });
      if (!endUser || endUser.applicationId !== id) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'END_USER_NOT_FOUND',
            message: `EndUser "${body.endUserId}" not found in this Application.`,
            fix: 'Verify the user id and that they signed up under this Application.',
          },
        });
      }
      const application = await applicationsService.get(id);
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      return { success: true, data: await usageService.listMeters(id, { take, skip }) };
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
          },
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
          '`APP_ADMIN` grant on it.',
      },
    },
    async (req) => {
      const { id, slug } = z
        .object({ id: z.string().min(1), slug: z.string().min(1) })
        .parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z.object({ active: z.boolean() }).parse(req.body);
      return { success: true, data: await usageService.setActive(id, slug, body.active) };
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const rows = await organizationsService.adminList({ applicationId: id, take, skip });
      return {
        success: true,
        data: rows.map((o) => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
          metadata: o.metadata ?? null,
          memberCount: o.memberCount,
          pendingInvitationCount: o.pendingInvitationCount,
          createdAt: o.createdAt.toISOString(),
          updatedAt: o.updatedAt.toISOString(),
        })),
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' } },
          required: ['id', 'orgId'],
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, orgId: { type: 'string' } },
          required: ['id', 'orgId'],
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
  // + API keys). Operator-gated (tenant session, OWNER/ADMIN) — it does not add
  // any end-user-facing reveal surface. Rotating invalidates any prior
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
