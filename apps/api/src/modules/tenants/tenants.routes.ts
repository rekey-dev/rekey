import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantsService } from './tenants.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { PaginationQuery, parsePagination, paginationJsonSchema } from '../../lib/pagination.js';

const CreateTenantBody = z.object({
  name: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
});

const TenantParams = z.object({ id: z.string().min(1) });

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
          'Subsequent Applications are created under POST /api/v1/admin/tenants/:id/applications.',
        body: {
          type: 'object',
          required: ['name', 'ownerEmail'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            ownerEmail: { type: 'string', format: 'email' },
          },
        },
      },
    },
    async (req, reply) => {
      const input = CreateTenantBody.parse(req.body);
      const tenant = await tenantsService.create(input);
      return reply.status(201).send({ success: true, data: tenant });
    },
  );
}
