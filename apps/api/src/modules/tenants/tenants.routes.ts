import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TenantLimitsSchema, type TenantLimits } from '@rekey.dev/shared-types';
import { tenantsService } from './tenants.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { RekeyError } from '../../lib/error.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { ok, okPage, errs, ref, type JsonSchema } from '../../lib/openapi.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';

/**
 * The 401/403/429 trio every `/api/v1/admin/*` route shares — `requireSuperAdmin`
 * runs as an `onRequest` hook, so these precede any route-specific failure.
 */
const SUPER_ADMIN_ERRORS = {
  401:
    'ADMIN_AUTH_MISSING — no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID — the ' +
    'value does not match `SUPER_ADMIN_KEY`.',
  403: 'ADMIN_IP_NOT_ALLOWED — the caller IP is outside `ADMIN_IP_ALLOWLIST`.',
  429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
} as const;

/** `TenantLimitsView` — the ceilings plus what's currently counted against them. */
const TenantLimitsView: JsonSchema = {
  type: 'object',
  description: "A workspace's resource ceilings plus what is currently counted against them.",
  properties: {
    limits: ref('TenantLimits'),
    usage: {
      type: 'object',
      properties: {
        activeEndUsers: {
          type: 'integer',
          description: 'Non-erased end-users across every Application in the workspace.',
        },
        productionApps: {
          type: 'integer',
          description: 'Applications in the workspace whose `environment` is `PRODUCTION`.',
        },
      },
      required: ['activeEndUsers', 'productionApps'],
    },
  },
  required: ['limits', 'usage'],
};

const CreateTenantBody = z.object({
  name: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
});

// PUT body = the limits object itself, validated strictly. A typo'd key
// ("maxEndUsers") must be a loud 400, not a silently-ignored no-op that leaves
// the operator believing they capped a workspace they didn't. Note this is
// checked in the handler rather than via `additionalProperties: false` in the
// route schema, because Fastify's AJV defaults to `removeAdditional: true` —
// it would strip the typo before we ever saw it.
const SetLimitsBody = TenantLimitsSchema.strict();

const TenantParams = z.object({ id: z.string().min(1) });

const AddMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
});

/**
 * Validate a limits object from a request body, or throw the 400 both writers
 * share. An unknown key is rejected rather than dropped: silently ignoring a
 * typo leaves the caller believing they capped a workspace they didn't.
 */
function parseLimitsOrThrow(value: unknown): TenantLimits {
  const parsed = SetLimitsBody.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  throw new RekeyError({
    statusCode: 400,
    code: 'INVALID_TENANT_LIMITS',
    message: `Limits body is not valid: ${parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`)
      .join('; ')}`,
    fix:
      'Send an object whose keys are `maxActiveEndUsers` and/or `maxProductionApps` ' +
      '(each a non-negative integer, or null for unlimited). Send `{}` to clear every ' +
      'limit.',
  });
}

/**
 * Tenant management endpoints. All under /api/v1/admin/tenants — all
 * gated by SUPER_ADMIN_KEY.
 */
export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/',
    {
      schema: {
        tags: ['Admin · Tenants'],
        security: [{ superAdminKey: [] }],
        summary: 'List all tenants',
        description: 'Returns Tenants newest-first (paginated). Bootstrap-admin only.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('Tenant'), 'A page of workspaces.'),
          ...errs({
            400: 'BAD_REQUEST — `limit` or `offset` is outside the declared range.',
            ...SUPER_ADMIN_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        tenantsService.list({ take, skip }),
        tenantsService.count(),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Admin · Tenants'],
        security: [{ superAdminKey: [] }],
        summary: 'Get a tenant by id',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(ref('Tenant'), 'The tenant.'),
          ...errs({
            ...SUPER_ADMIN_ERRORS,
            404: 'TENANT_NOT_FOUND — no tenant with that id.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = TenantParams.parse(req.params);
      return { success: true, data: await tenantsService.get(id) };
    },
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Admin · Tenants'],
        security: [{ superAdminKey: [] }],
        summary: 'Create a tenant',
        description:
          'Creates a new Tenant. The first call also bootstraps the system. ' +
          'Subsequent Applications are created under POST /api/v1/admin/tenants/:id/applications.\n\n' +
          'Optional `limits` sets this workspace\'s ceilings at creation and overrides the ' +
          'deployment-wide `DEFAULT_TENANT_LIMITS`. Omit it to take that default, which is ' +
          'unlimited unless the deployment configured one.',
        body: {
          type: 'object',
          required: ['name', 'ownerEmail'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            ownerEmail: { type: 'string', format: 'email' },
            // Left shapeless on purpose: Fastify's AJV runs with
            // `removeAdditional: true`, so declaring the keys here would strip
            // a typo'd one before the strict Zod parse could reject it.
            limits: { type: 'object' },
          },
        },
        response: {
          201: ok(ref('Tenant'), 'The created tenant.'),
          ...errs({
            400:
              'BAD_REQUEST — `name` or `ownerEmail` failed schema validation; or ' +
              'INVALID_TENANT_LIMITS — `limits` has an unknown key or an invalid value.',
            ...SUPER_ADMIN_ERRORS,
          }),
        },
      },
    },
    async (req, reply) => {
      const input = CreateTenantBody.parse(req.body);
      // Validated separately from the rest of the body so an unknown key is a
      // 400 with the same INVALID_TENANT_LIMITS contract as PUT /:id/limits.
      // Absent means "take the deployment default"; `{}` means "unlimited,
      // deliberately" — both of which the service distinguishes.
      const raw = (req.body as { limits?: unknown } | undefined)?.limits;
      const tenant = await tenantsService.create({
        ...input,
        ...(raw !== undefined && { limits: parseLimitsOrThrow(raw) }),
      });
      return reply.status(201).send({ success: true, data: tenant });
    },
  );

  // ---------- Workspace membership ----------
  //
  // The gap this closes: `POST /` creates a bare Tenant, and `ownerEmail` on
  // it is a LABEL, not an access grant — every path that actually reaches a
  // workspace runs through `TenantMembership`. So an admin-created Tenant was
  // a workspace nobody could open, holding whatever ceiling it was given.
  //
  // Every other way to write a membership requires either a brand-new operator
  // (`signUpAndCreateWorkspace`, `findOrCreateOAuthOperator`) or a live
  // operator session (`createWorkspaceForUser`). A deployment's own
  // provisioning automation has neither: it is acting FOR an operator who
  // already exists, from a service with no session. That is this route.
  //
  // Deliberately admin-only and deliberately not a way to escalate: it grants
  // access to a workspace, and the operator it names must already exist. It is
  // audited for the same reason `admin.operator_invite.minted` is — a
  // membership appearing without an invitation should be explicable.
  app.post(
    '/:id/members',
    {
      schema: {
        tags: ['Admin · Tenants'],
        security: [{ superAdminKey: [] }],
        summary: 'Add an existing operator to a workspace',
        description:
          'Grants an existing operator (by email) a membership in this workspace. Idempotent: ' +
          'if they are already a member the existing membership is returned unchanged, and the ' +
          'role is NOT rewritten — use the workspace role endpoint to change a role.\n\n' +
          'For deployment automation that provisions workspaces on behalf of operators. ' +
          'A workspace created by POST /api/v1/admin/tenants has no members and cannot be ' +
          'opened by anyone until this is called.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                membershipId: { type: 'string' },
                tenantId: { type: 'string' },
                tenantUserId: { type: 'string' },
                role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
                created: { type: 'boolean' },
              },
              required: ['membershipId', 'tenantId', 'tenantUserId', 'role', 'created'],
            },
            'The membership. `created` is false when it already existed.',
          ),
          ...errs({
            400: 'BAD_REQUEST — `email` or `role` failed schema validation.',
            404:
              'TENANT_NOT_FOUND — no such workspace; or OPERATOR_NOT_FOUND — no operator with ' +
              'that email. This route grants access to an existing operator; it never creates one.',
            ...SUPER_ADMIN_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { id } = TenantParams.parse(req.params);
      const body = AddMemberBody.parse(req.body);
      const result = await tenantsService.addMember({
        tenantId: id,
        email: body.email,
        role: body.role ?? 'OWNER',
      });
      if (result.created) {
        const { ip, userAgent } = requestContext(req);
        void recordSecurityEvent({
          type: 'workspace.member_added_by_admin',
          actorType: 'system',
          tenantId: id,
          ip,
          userAgent,
          metadata: { tenantUserId: result.tenantUserId, role: result.role },
        });
      }
      return { success: true, data: result };
    },
  );

  // ---------- Workspace limits ----------
  //
  // Deliberately mounted under the SUPER_ADMIN_KEY surface and nowhere else.
  // A workspace operator (tenant session) has no route that writes here — a
  // quota you can raise yourself is not a quota. See lib/tenant-limits.ts.

  app.get(
    '/:id/limits',
    {
      schema: {
        tags: ['Admin · Tenants'],
        security: [{ superAdminKey: [] }],
        summary: 'Get a tenant\'s resource limits and current usage',
        description:
          'Returns the workspace\'s ceilings plus what is currently counted against them.\n\n' +
          'An omitted or `null` limit means **unlimited** — the default for every workspace, ' +
          'so a deployment that never sets limits is unconstrained.\n\n' +
          '`usage.activeEndUsers` counts non-erased EndUsers across **all** Applications in ' +
          'the workspace (limits are workspace-wide, not per-Application). ' +
          '`usage.productionApps` counts Applications whose `environment` is `PRODUCTION`; ' +
          'staging and development Applications are never counted.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(TenantLimitsView, "The workspace's ceilings plus current usage."),
          ...errs({
            ...SUPER_ADMIN_ERRORS,
            404: 'TENANT_NOT_FOUND — no tenant with that id.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = TenantParams.parse(req.params);
      return { success: true, data: await tenantsService.getLimits(id) };
    },
  );

  app.put(
    '/:id/limits',
    {
      schema: {
        tags: ['Admin · Tenants'],
        security: [{ superAdminKey: [] }],
        summary: 'Set a tenant\'s resource limits',
        description:
          'Replaces the workspace\'s limits wholesale (PUT, not PATCH — an omitted key ' +
          'becomes unlimited). Send `{}` to clear every limit.\n\n' +
          'Requires `SUPER_ADMIN_KEY`: this is a deployment-level control, and a workspace ' +
          'operator must not be able to raise their own ceiling.\n\n' +
          'Limits gate **creation** only. Setting a limit below current usage is allowed and ' +
          'never signs anyone out or takes an application offline — existing end-users keep ' +
          'working and existing production applications keep serving traffic. New sign-ups ' +
          '(and new production applications) fail with `TENANT_QUOTA_EXCEEDED` until usage ' +
          'drops below the line.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            maxActiveEndUsers: {
              // `nullable: true`, not `type: ['integer', 'null']`. The draft-07
              // type-array form is not valid OpenAPI 3.0 (which is what this
              // document declares), so it made the published openapi.json fail
              // every real validator — nobody could generate a client from it.
              // Fastify's ajv treats the two identically at runtime (verified:
              // null accepted, integer accepted, string 400s either way), so
              // this is a spelling change, not a contract change.
              type: 'integer',
              nullable: true,
              minimum: 0,
              description:
                'Max non-erased EndUsers across every Application in this workspace. ' +
                'Null or omitted = unlimited.',
            },
            maxProductionApps: {
              // See the note on `maxActiveEndUsers` above.
              type: 'integer',
              nullable: true,
              minimum: 0,
              description:
                'Max Applications in this workspace with `environment: PRODUCTION`. ' +
                'Staging and development Applications are never counted and never blocked. ' +
                'Null or omitted = unlimited.',
            },
          },
        },
        response: {
          200: ok(TenantLimitsView, "The workspace's ceilings plus current usage, after the update."),
          ...errs({
            400:
              'BAD_REQUEST — `maxActiveEndUsers` or `maxProductionApps` failed schema ' +
              'validation; or INVALID_TENANT_LIMITS — the body has an unknown key.',
            ...SUPER_ADMIN_ERRORS,
            404: 'TENANT_NOT_FOUND — no tenant with that id.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = TenantParams.parse(req.params);
      return { success: true, data: await tenantsService.setLimits(id, parseLimitsOrThrow(req.body)) };
    },
  );
}
