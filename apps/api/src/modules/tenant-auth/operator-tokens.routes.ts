/**
 * Operator-PAT-gated tenant routes.
 *
 * These are the routes an AI agent (or any non-interactive automation) calls
 * with an operator personal-access-token (`Authorization: Bearer rp_op_…`)
 * instead of a short-lived session JWT — replacing reliance on the global
 * SUPER_ADMIN_KEY.
 *
 * Every route here authenticates via `resolveOperatorToken` (which decorates
 * req.tenantId / req.tenantUser / req.tenantRole exactly like a session) and is
 * default-deny on writes: the mint endpoint additionally requires the PAT to
 * carry the `keys:mint` scope. We deliberately reuse the existing services
 * (`applicationsService`, `apiKeysService`) and only add the PAT auth + scope
 * gate + tenant-ownership check — no duplicated business logic, no weakening of
 * the session-gated `/api/v1/tenant/applications/*` surface.
 *
 * Mounted under /api/v1/tenant/operator.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applicationsService } from '../applications/applications.service.js';
import { apiKeysService } from '../api-keys/api-keys.service.js';
import { RekeyError } from '../../lib/error.js';
import {
  resolveOperatorToken,
  requireOperatorScope,
} from '../../middleware/operator-token-auth.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';

/**
 * Make sure the named application belongs to the workspace the PAT is bound to.
 * Mirrors `tenant-applications.ensureAppInTenant` — same "not found" code for a
 * cross-tenant app so a PAT can't be used as a tenant-enumeration oracle.
 */
async function ensureAppInTenant(applicationId: string, tenantId: string): Promise<void> {
  const app = await applicationsService.get(applicationId);
  if (app.tenantId !== tenantId) {
    throw new RekeyError({
      statusCode: 404,
      code: 'APPLICATION_NOT_FOUND',
      message: `Application "${applicationId}" not found in this workspace.`,
      fix: 'List applications via GET /api/v1/tenant/operator/applications.',
    });
  }
}

const AppParam = z.object({ id: z.string().min(1) });

const MintKeyBody = z.object({
  name: z.string().min(1).max(120),
  mode: z.enum(['live', 'test']).default('live'),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});

export async function operatorTokenRoutes(app: FastifyInstance): Promise<void> {
  // Every route in this plugin is authenticated by an operator PAT.
  app.addHook('onRequest', resolveOperatorToken);

  // ---------- Applications (read scope) ----------

  app.get(
    '/applications',
    {
      preHandler: requireOperatorScope('read'),
      schema: {
        tags: ['Tenant · Operator PAT'],
        security: [{ operatorPat: [] }],
        summary: 'List Applications in the PAT\'s workspace (requires `read` scope)',
      },
    },
    async (req) => {
      return { success: true, data: await applicationsService.list(req.tenantId!) };
    },
  );

  // ---------- API keys ----------

  app.get(
    '/applications/:id/api-keys',
    {
      preHandler: requireOperatorScope('read'),
      schema: {
        tags: ['Tenant · Operator PAT'],
        security: [{ operatorPat: [] }],
        summary: 'List active API keys for an application (requires `read` scope)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppInTenant(id, req.tenantId!);
      return { success: true, data: await apiKeysService.listForApplication(id) };
    },
  );

  app.post(
    '/applications/:id/api-keys',
    {
      // Default-deny: minting an Application API key needs the 'keys:mint' scope.
      preHandler: requireOperatorScope('keys:mint'),
      schema: {
        tags: ['Tenant · Operator PAT'],
        security: [{ operatorPat: [] }],
        summary: 'Mint an Application API key via an operator PAT (requires `keys:mint` scope)',
        description:
          'Mints an Application secret key. The PAT must carry the `keys:mint` scope and be bound ' +
          'to the workspace that owns the application. The `rawKey` is shown exactly once.',
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
      await ensureAppInTenant(id, req.tenantId!);
      const body = MintKeyBody.parse(req.body);
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
        // Note the actor authenticated via PAT, for forensics.
        metadata: {
          apiKeyId: result.apiKey.id,
          name: body.name,
          mode: body.mode,
          scopes: body.scopes,
          via: 'operator_pat',
        },
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
}
