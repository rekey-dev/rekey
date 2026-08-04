import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeysService } from './api-keys.service.js';
import { applicationsService } from '../applications/index.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { ok, okArray, errs, ref, type JsonSchema } from '../../lib/openapi.js';

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

/** The mint response: the newly created key plus its one-time raw secret. */
const MintedApiKey: JsonSchema = {
  type: 'object',
  properties: {
    apiKey: ref('ApiKey'),
    rawKey: {
      type: 'string',
      description:
        'The raw secret key. Returned exactly once, at mint time — no endpoint can ever ' +
        'return it again. Only its SHA-256 hash is stored, so losing it means revoking and ' +
        'minting a replacement.',
    },
    warning: {
      type: 'string',
      description: 'Human-readable restatement of the one-time-only warning above.',
    },
  },
  required: ['apiKey', 'rawKey', 'warning'],
};

const Params = z.object({ id: z.string().min(1) });
const KeyParams = z.object({ id: z.string().min(1), keyId: z.string().min(1) });

const CreateKeyBody = z.object({
  name: z.string().min(1).max(120),
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
        response: {
          200: okArray(
            ref('ApiKey'),
            'Active (non-revoked) keys for the application, newest first. Bounded by ' +
              'construction — an application can hold at most 25 active keys.',
          ),
          ...errs({
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND — no application with that id.',
          }),
        },
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
        response: {
          201: ok(MintedApiKey, 'The newly minted key. Store `rawKey` now — it is shown exactly once.'),
          ...errs({
            400:
              'BAD_REQUEST — the body failed schema validation; or API_KEY_EXPIRY_IN_PAST — ' +
              '`expiresAt` is not in the future; or API_KEY_LIMIT_REACHED — the application ' +
              'already has 25 active keys.',
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND — no application with that id.',
          }),
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
        response: {
          200: ok(ref('ApiKey'), 'The revoked key (or, if already revoked, the unchanged key).'),
          ...errs({
            ...SUPER_ADMIN_ERRORS,
            404:
              'API_KEY_NOT_FOUND — no key with that id under this application (also returned ' +
              'when `id` itself does not name an application).',
          }),
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
