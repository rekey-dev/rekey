import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applicationsService } from './applications.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { BillingProviderSchema } from '@relipay/shared-types';
import { PaginationQuery, parsePagination, paginationJsonSchema } from '../../lib/pagination.js';

const CreateApplicationBody = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(40),
  billingProvider: BillingProviderSchema.optional(),
  enableBilling: z.boolean().optional(),
  authConfig: z
    .object({
      methods: z.array(z.enum(['password', 'google', 'github', 'magic_link'])).optional(),
      passwordMinLength: z.number().int().min(8).optional(),
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
      },
    },
    async (req) => {
      const { tenantId, ...page } = ListQuery.parse(req.query);
      const { take, skip } = parsePagination(page);
      return { success: true, data: await applicationsService.list(tenantId, { take, skip }) };
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
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      return { success: true, data: await applicationsService.get(id) };
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
                passwordMinLength: { type: 'integer', minimum: 8 },
                redirectUrls: { type: 'array', items: { type: 'string', format: 'uri' } },
                organizationsEnabled: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const input = CreateApplicationBody.parse(req.body);
      const application = await applicationsService.create({
        tenantId: input.tenantId,
        name: input.name,
        slug: input.slug,
        ...(input.billingProvider !== undefined && { billingProvider: input.billingProvider }),
        ...(input.enableBilling !== undefined && { enableBilling: input.enableBilling }),
        ...(input.authConfig !== undefined && { authConfig: input.authConfig }),
      });
      return reply.status(201).send({ success: true, data: application });
    },
  );
}
