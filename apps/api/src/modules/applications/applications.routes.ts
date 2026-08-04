import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applicationsService } from './applications.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { AppEnvironmentSchema, BillingProviderSchema } from '@rekey.dev/shared-types';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { stripApplicationSecrets } from '../../lib/app-access.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';

/**
 * The 401/403 pair every `/api/v1/admin/*` route shares — `requireSuperAdmin`
 * runs as an `onRequest` hook, so these precede any route-specific failure.
 */
const SUPER_ADMIN_ERRORS = {
  401:
    'ADMIN_AUTH_MISSING — no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID — the ' +
    'value does not match `SUPER_ADMIN_KEY`.',
  403: 'ADMIN_IP_NOT_ALLOWED — the caller IP is outside `ADMIN_IP_ALLOWLIST`.',
  429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
} as const;

const CreateApplicationBody = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(40),
  // Write-once, and the field that decides whether the Application counts
  // against `maxProductionApps`. The tenant-facing create route has always
  // accepted it; this surface silently dropped it, so a super-admin (or a
  // deployment's own provisioning automation) could not create anything but a
  // DEVELOPMENT app.
  environment: AppEnvironmentSchema.optional(),
  billingProvider: BillingProviderSchema.optional(),
  enableBilling: z.boolean().optional(),
  authConfig: z
    .object({
      methods: z.array(z.enum(['password', 'google', 'github', 'magic_link'])).optional(),
      passwordMinLength: z.number().int().min(8).max(1024).optional(),
      redirectUrls: z.array(z.string().url()).optional(),
      organizationsEnabled: z.boolean().optional(),
    })
    .optional(),
});

const Params = z.object({ id: z.string().min(1) });
const ListQuery = z.object({ tenantId: z.string().min(1).optional() }).merge(PaginationQuery);

export async function applicationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/',
    {
      schema: {
        tags: ['Admin · Applications'],
        security: [{ superAdminKey: [] }],
        summary: 'List applications',
        description: 'Optionally filter by `tenantId`.',
        querystring: {
          type: 'object',
          properties: { tenantId: { type: 'string' }, ...paginationJsonSchema },
        },
        response: {
          200: okPage(ref('Application'), 'A page of applications, newest first.'),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...SUPER_ADMIN_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { tenantId, ...page } = ListQuery.parse(req.query);
      const { take, skip } = parsePagination(page);
      const [items, total] = await Promise.all([
        applicationsService.list(tenantId, { take, skip }),
        applicationsService.count(tenantId),
      ]);
      return {
        success: true,
        data: paged(items.map(stripApplicationSecrets), total, take, skip),
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Admin · Applications'],
        security: [{ superAdminKey: [] }],
        summary: 'Get an application by id',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(ref('Application'), 'The application.'),
          ...errs({
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND — no application with that id.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      return { success: true, data: stripApplicationSecrets(await applicationsService.get(id)) };
    },
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Admin · Applications'],
        security: [{ superAdminKey: [] }],
        summary: 'Create an application under a tenant',
        description:
          'Mints a unique slug, public key, and default auth/billing config. ' +
          'Use POST /api/v1/admin/applications/:id/api-keys to mint a secret key for the SDK.',
        body: {
          type: 'object',
          required: ['tenantId', 'name', 'slug'],
          properties: {
            tenantId: { type: 'string' },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            slug: {
              type: 'string',
              minLength: 1,
              maxLength: 40,
              description: 'URL-safe lowercase identifier. Letters, digits, hyphens only.',
            },
            environment: {
              type: 'string',
              enum: ['PRODUCTION', 'STAGING', 'DEVELOPMENT'],
              description:
                'Defaults to DEVELOPMENT. Write-once — it cannot be changed after creation, ' +
                'so create a separate Application per environment. Only PRODUCTION counts ' +
                'against the workspace `maxProductionApps` limit.',
            },
            billingProvider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] },
            enableBilling: {
              type: 'boolean',
              description: 'Provision with the billing surface enabled. Defaults false.',
            },
            authConfig: {
              type: 'object',
              properties: {
                methods: {
                  type: 'array',
                  items: { type: 'string', enum: ['password', 'google', 'github', 'magic_link'] },
                },
                passwordMinLength: { type: 'integer', minimum: 8, maximum: 2147483647 },
                redirectUrls: { type: 'array', items: { type: 'string', format: 'uri' } },
                organizationsEnabled: { type: 'boolean' },
              },
            },
          },
        },
        response: {
          201: ok(ref('Application'), 'The created application.'),
          ...errs({
            400:
              'APPLICATION_SLUG_INVALID — the slug is not URL-safe; or VALIDATION_ERROR — a ' +
              'field failed schema validation.',
            ...SUPER_ADMIN_ERRORS,
            403:
              'ADMIN_IP_NOT_ALLOWED — the caller IP is outside `ADMIN_IP_ALLOWLIST`; or ' +
              'TENANT_QUOTA_EXCEEDED — creating a PRODUCTION application would exceed the ' +
              "workspace's `maxProductionApps`.",
            404: 'TENANT_NOT_FOUND — no tenant with that `tenantId`.',
            409:
              'APPLICATION_SLUG_TAKEN — another application already uses that slug ' +
              '(slugs are unique deployment-wide).',
          }),
        },
      },
    },
    async (req, reply) => {
      const input = CreateApplicationBody.parse(req.body);
      const application = await applicationsService.create({
        tenantId: input.tenantId,
        name: input.name,
        slug: input.slug,
        ...(input.environment !== undefined && { environment: input.environment }),
        ...(input.billingProvider !== undefined && { billingProvider: input.billingProvider }),
        ...(input.enableBilling !== undefined && { enableBilling: input.enableBilling }),
        ...(input.authConfig !== undefined && { authConfig: input.authConfig }),
      });
      return reply
        .status(201)
        .send({ success: true, data: stripApplicationSecrets(application) });
    },
  );
}
