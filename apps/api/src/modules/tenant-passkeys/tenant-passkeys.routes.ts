/**
 * Operator passkey routes.
 *
 * Split into two plugins:
 *   - `tenantPasskeysAuthenticatedRoutes` — under /tenant/auth/passkeys
 *     (register, list, delete). Requires an authenticated tenant session.
 *   - `tenantPasskeysPublicRoutes` — under /tenant/auth/passkeys (auth
 *     ceremony) — unauthenticated; the passkey IS the auth factor.
 *
 * The route prefixes overlap deliberately so the public surface looks
 * like a single /tenant/auth/passkeys/* namespace.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantPasskeysService } from './tenant-passkeys.service.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';

const RegisterCompleteBody = z.object({
  response: z.unknown(),
  expectedChallenge: z.string().min(1).max(1024),
  deviceName: z.string().min(1).max(64).optional(),
});

const AuthenticateCompleteBody = z.object({
  response: z.unknown(),
  expectedChallenge: z.string().min(1).max(1024),
});

const IdParams = z.object({ id: z.string().min(1) });

function deviceContext(req: { headers: Record<string, unknown>; ip: string }): {
  userAgent: string | null;
  ip: string | null;
} {
  const ua = req.headers['user-agent'];
  return {
    userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null,
    ip: req.ip,
  };
}

export async function tenantPasskeysAuthenticatedRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/passkeys',
    {
      schema: {
        tags: ['Tenant · Passkeys'],
        security: [{ tenantSession: [] }],
        summary: 'List operator passkeys',
      },
    },
    async (req) => {
      const rows = await tenantPasskeysService.list(req.tenantUser!.id);
      return { success: true, data: { passkeys: rows } };
    },
  );

  app.post(
    '/passkeys/register/start',
    {
      schema: {
        tags: ['Tenant · Passkeys'],
        security: [{ tenantSession: [] }],
        summary: 'Begin a registration ceremony for the current operator',
      },
    },
    async (req) => {
      const result = await tenantPasskeysService.registerStart(req.tenantUser!.id);
      return { success: true, data: result };
    },
  );

  app.post(
    '/passkeys/register/complete',
    {
      schema: {
        tags: ['Tenant · Passkeys'],
        security: [{ tenantSession: [] }],
        summary: 'Complete a registration ceremony; stores the credential',
        body: {
          type: 'object',
          required: ['response', 'expectedChallenge'],
          properties: {
            response: { type: 'object' },
            expectedChallenge: { type: 'string', minLength: 1, maxLength: 1024 },
            deviceName: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = RegisterCompleteBody.parse(req.body);
      const row = await tenantPasskeysService.registerComplete({
        tenantUserId: req.tenantUser!.id,
        expectedChallenge: body.expectedChallenge,
        response: body.response as never,
        ...(body.deviceName !== undefined && { deviceName: body.deviceName }),
      });
      return reply.status(201).send({ success: true, data: row });
    },
  );

  app.delete(
    '/passkeys/:id',
    {
      schema: {
        tags: ['Tenant · Passkeys'],
        security: [{ tenantSession: [] }],
        summary: 'Remove a passkey from the current operator',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const params = IdParams.parse(req.params);
      await tenantPasskeysService.delete({
        tenantUserId: req.tenantUser!.id,
        passkeyId: params.id,
      });
      return { success: true, data: { id: params.id } };
    },
  );
}

/**
 * Operator passkey **sign-in** ceremony — genuinely unauthenticated (`security: []`).
 * No hook is registered here on purpose: the caller has no session yet, and the
 * WebAuthn assertion itself is the credential. Registered under the same
 * `/api/v1/tenant/auth` prefix as the session-gated plugin above; Fastify
 * encapsulation keeps `requireTenantSession` off these two routes.
 */
export async function tenantPasskeysPublicRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/passkeys/authenticate/start',
    {
      schema: {
        tags: ['Tenant · Passkeys'],
        security: [],
        summary: 'Begin a passkey sign-in ceremony for an operator (usernameless)',
      },
    },
    async () => {
      const result = await tenantPasskeysService.authenticateStart();
      return { success: true, data: result };
    },
  );

  app.post(
    '/passkeys/authenticate/complete',
    {
      schema: {
        tags: ['Tenant · Passkeys'],
        security: [],
        summary: 'Complete a passkey sign-in; mints a session',
        body: {
          type: 'object',
          required: ['response', 'expectedChallenge'],
          properties: {
            response: { type: 'object' },
            expectedChallenge: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (req) => {
      const body = AuthenticateCompleteBody.parse(req.body);
      const session = await tenantPasskeysService.authenticateComplete({
        expectedChallenge: body.expectedChallenge,
        response: body.response as never,
        device: deviceContext(req as { headers: Record<string, unknown>; ip: string }),
      });
      return { success: true, data: session };
    },
  );
}
