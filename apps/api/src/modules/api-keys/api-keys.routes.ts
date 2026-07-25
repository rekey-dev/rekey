import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeysService } from './api-keys.service.js';
import { applicationsService } from '../applications/index.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';

const Params = z.object({ id: z.string().min(1) });
const KeyParams = z.object({ id: z.string().min(1), keyId: z.string().min(1) });

const CreateKeyBody = z.object({
  name: z.string().min(1).max(120),
  mode: z.enum(['live', 'test']).default('live'),
  scopes: z.array(z.string()).default([]),
  /** ISO-8601 string. Omit for non-expiring keys. */
  expiresAt: z.string().datetime().optional(),
});

export async function apiKeysRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/:id/api-keys',
    {
      schema: {
        tags: ['Admin · API Keys'],
        security: [{ superAdminKey: [] }],
        summary: 'List active API keys for an application',
        description: 'Returns key metadata only. The raw key value is unrecoverable after creation.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      await applicationsService.get(id); // ensures 404 has the standard fix message
      const keys = await apiKeysService.listForApplication(id);
      return { success: true, data: keys };
    },
  );

  app.post(
    '/:id/api-keys',
    {
      schema: {
        tags: ['Admin · API Keys'],
        security: [{ superAdminKey: [] }],
        summary: 'Mint an API key for an application',
        description:
          'Returns the raw key in `data.rawKey`. **Show this to the operator exactly once** — ' +
          'we only store its SHA-256 hash, so the value is unrecoverable after this response.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              description: 'Human-readable label, e.g. "CI server", "Staging worker".',
            },
            mode: {
              type: 'string',
              enum: ['live', 'test'],
              default: 'live',
              description: '`test` keys are intended for sandboxes; format is otherwise identical.',
            },
            scopes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Defaults to `["*"]` (full access). Use `auth:read`, `billing:write`, etc., to scope.',
            },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'Optional ISO-8601 expiry. Omit for non-expiring keys.',
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = Params.parse(req.params);
      await applicationsService.get(id);
      const body = CreateKeyBody.parse(req.body);

      const result = await apiKeysService.create({
        applicationId: id,
        name: body.name,
        mode: body.mode,
        scopes: body.scopes,
        ...(body.expiresAt !== undefined && { expiresAt: new Date(body.expiresAt) }),
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
        tags: ['Admin · API Keys'],
        security: [{ superAdminKey: [] }],
        summary: 'Revoke an API key',
        description: 'Soft-revokes the key (sets `revokedAt`). Idempotent.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, keyId: { type: 'string' } },
          required: ['id', 'keyId'],
        },
      },
    },
    async (req) => {
      const { id, keyId } = KeyParams.parse(req.params);
      const key = await apiKeysService.revoke(id, keyId);
      return { success: true, data: key };
    },
  );
}
