import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantMfaService } from './tenant-mfa.service.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { authRateLimit } from '../../lib/rate-limit.js';

const CodeBody = z.object({ code: z.string().min(1).max(64) });

export async function tenantMfaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/status',
    {
      schema: {
        tags: ['Tenant · MFA'],
        security: [{ tenantSession: [] }],
        summary: 'MFA status for the operator',
      },
    },
    async (req) => ({ success: true, data: await tenantMfaService.status(req.tenantUser!.id) }),
  );

  app.post(
    '/setup',
    {
      schema: {
        tags: ['Tenant · MFA'],
        security: [{ tenantSession: [] }],
        summary: 'Mint a new TOTP secret + 10 backup codes',
        description:
          'Returns the otpauth URI for QR + backup codes (one-time-show). Not enrolled until /setup-confirm.',
      },
    },
    async (req, reply) => {
      const result = await tenantMfaService.setup({
        tenantUserId: req.tenantUser!.id,
        email: req.tenantUser!.email,
      });
      return reply.status(201).send({
        success: true,
        data: {
          otpauthUrl: result.otpauthUrl,
          backupCodes: result.backupCodes,
          warning: 'Show backup codes ONCE. Only SHA-256 hashes are stored.',
        },
      });
    },
  );

  app.post(
    '/setup-confirm',
    {
      // Code-guessing surface — tight per-route HTTP cap.
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · MFA'],
        security: [{ tenantSession: [] }],
        summary: 'Confirm enrollment with the current TOTP code',
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req) => {
      const body = CodeBody.parse(req.body);
      return {
        success: true,
        data: await tenantMfaService.confirm({
          tenantUserId: req.tenantUser!.id,
          code: body.code,
        }),
      };
    },
  );

  app.post(
    '/disable',
    {
      schema: {
        tags: ['Tenant · MFA'],
        security: [{ tenantSession: [] }],
        summary: 'Disable MFA for the operator',
      },
    },
    async (req) => {
      await tenantMfaService.disable(req.tenantUser!.id);
      return { success: true, data: { disabled: true } };
    },
  );
}
