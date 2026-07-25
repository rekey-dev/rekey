import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { plansService } from './plans.service.js';
import { applicationsService } from '../applications/applications.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';

const Params = z.object({ id: z.string().min(1) });
const PlanParams = z.object({ id: z.string().min(1), slug: z.string().min(1) });
const ListQuery = z.object({ includeInactive: z.coerce.boolean().optional() });

const CreateBody = z.object({
  slug: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  amount: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ActiveBody = z.object({ active: z.boolean() });

export async function plansRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/:id/plans',
    {
      schema: {
        tags: ['Admin · Plans'],
        security: [{ superAdminKey: [] }],
        summary: 'List plans for an application',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: { includeInactive: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      const { includeInactive } = ListQuery.parse(req.query);
      await applicationsService.get(id);
      return {
        success: true,
        data: await plansService.listForApplication(id, includeInactive ?? false),
      };
    },
  );

  app.post(
    '/:id/plans',
    {
      schema: {
        tags: ['Admin · Plans'],
        security: [{ superAdminKey: [] }],
        summary: 'Create a plan',
        description:
          'Creates a Plan locally, then registers it with the Application\'s billing provider. ' +
          'Amount is in the smallest currency unit (cents/paise/sen — never a decimal float).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['slug', 'name', 'amount'],
          properties: {
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            amount: { type: 'integer', minimum: 0, description: 'Smallest currency unit (e.g. cents).' },
            currency: { type: 'string', minLength: 3, maxLength: 3, description: 'ISO 4217. Defaults to USD.' },
            interval: { type: 'string', enum: ['MONTH', 'YEAR'] },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = Params.parse(req.params);
      const body = CreateBody.parse(req.body);
      const plan = await plansService.create({
        applicationId: id,
        slug: body.slug,
        name: body.name,
        amount: body.amount,
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.interval !== undefined && { interval: body.interval }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return reply.status(201).send({ success: true, data: plan });
    },
  );

  app.patch(
    '/:id/plans/:slug',
    {
      schema: {
        tags: ['Admin · Plans'],
        security: [{ superAdminKey: [] }],
        summary: 'Toggle a plan\'s active flag',
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
      const { id, slug } = PlanParams.parse(req.params);
      const body = ActiveBody.parse(req.body);
      return { success: true, data: await plansService.setActive(id, slug, body.active) };
    },
  );
}
