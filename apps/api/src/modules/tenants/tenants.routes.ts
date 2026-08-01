import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TenantLimitsSchema, type TenantLimits } from '@rekey.dev/shared-types';
import { tenantsService } from './tenants.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { RekeyError } from '../../lib/error.js';
import { PaginationQuery, parsePagination, paginationJsonSchema } from '../../lib/pagination.js';

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
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      return { success: true, data: await tenantsService.list({ take, skip }) };
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
              type: ['integer', 'null'],
              minimum: 0,
              description:
                'Max non-erased EndUsers across every Application in this workspace. ' +
                'Null or omitted = unlimited.',
            },
            maxProductionApps: {
              type: ['integer', 'null'],
              minimum: 0,
              description:
                'Max Applications in this workspace with `environment: PRODUCTION`. ' +
                'Staging and development Applications are never counted and never blocked. ' +
                'Null or omitted = unlimited.',
            },
          },
        },
      },
    },
    async (req) => {
      const { id } = TenantParams.parse(req.params);
      return { success: true, data: await tenantsService.setLimits(id, parseLimitsOrThrow(req.body)) };
    },
  );
}
