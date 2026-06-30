/**
 * End-user MFA routes.
 *
 * setup → confirm → (sign-in challenges fire from now on)
 *
 * The sign-in flow's MFA challenge isn't here — sign-in itself is in
 * `modules/auth`. For Phase 4.4 we kept it simple: existing /sign-in
 * issues a session AS USUAL even when MFA is enrolled. The customer's
 * server is expected to treat MFA as "step-up" — gate sensitive actions
 * by also calling /mfa/challenge with a fresh code. A follow-up can
 * add the "session is unusable until MFA challenge passes" semantics.
 */

import type { FastifyInstance } from 'fastify';
import type { Application } from '@prisma/client';
import { z } from 'zod';
import { AuthConfigSchema } from '@relipay/shared-types';
import { mfaService } from './mfa.service.js';
import { RelipayError } from '../../lib/error.js';
import { requireApiKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { authRateLimit } from '../../lib/rate-limit.js';

const CodeBody = z.object({ code: z.string().min(1).max(64) });

/** End-user MFA is gated by the Application's `authConfig.mfa` policy. */
function mfaPolicy(application: Application): 'off' | 'optional' | 'required' {
  return AuthConfigSchema.parse(application.authConfig).mfa;
}
function assertMfaEnabled(application: Application): void {
  if (mfaPolicy(application) === 'off') {
    throw new RelipayError({
      statusCode: 403,
      code: 'MFA_NOT_ENABLED',
      message: 'Two-factor authentication is not enabled for this Application.',
      fix: 'An operator can enable it in the panel: Application → Auth → Two-factor (set to Optional or Required).',
    });
  }
}

export async function mfaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireScope('auth:write'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/status',
    {
      schema: {
        tags: ['Public · MFA'],
        summary: 'MFA status for the current user',
      },
    },
    async (req) => ({
      success: true,
      data: { ...(await mfaService.status(req.endUser!.id)), policy: mfaPolicy(req.application!) },
    }),
  );

  app.post(
    '/setup',
    {
      schema: {
        tags: ['Public · MFA'],
        summary: 'Mint a new TOTP secret + 10 backup codes (one-time-show). Not enrolled until /setup-confirm.',
      },
    },
    async (req, reply) => {
      assertMfaEnabled(req.application!);
      const result = await mfaService.setup({
        endUser: { ...req.endUser!, passwordHash: null } as never,
        // Keep "ReliPay" branded — could be made app-aware via Application.name later.
        issuer: 'ReliPay',
      });
      return reply.status(201).send({
        success: true,
        data: {
          otpauthUrl: result.otpauthUrl,
          backupCodes: result.backupCodes,
          warning:
            'Show backupCodes ONCE. Only SHA-256 hashes are stored — they cannot be recovered.',
        },
      });
    },
  );

  app.post(
    '/setup-confirm',
    {
      // Code-guessing surface — tight HTTP cap layered on top of the Redis
      // per-credential limiter (which fails open when Redis is down).
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · MFA'],
        summary: 'Confirm MFA enrollment by entering the current 6-digit code',
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req) => {
      const body = CodeBody.parse(req.body);
      const result = await mfaService.confirm({
        endUserId: req.endUser!.id,
        code: body.code,
        application: req.application!,
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/challenge',
    {
      // Code-guessing surface — tight HTTP cap layered on top of the Redis
      // per-credential limiter (which fails open when Redis is down).
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · MFA'],
        summary: 'Verify a TOTP or backup code (step-up auth). Returns { ok: bool }.',
        description: 'Backup codes are single-use — consumed on success.',
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req) => {
      const body = CodeBody.parse(req.body);
      const ok = await mfaService.verify({
        endUserId: req.endUser!.id,
        code: body.code,
      });
      return { success: true, data: { ok } };
    },
  );

  app.post(
    '/disable',
    {
      schema: {
        tags: ['Public · MFA'],
        summary: 'Disable MFA for the current user',
      },
    },
    async (req) => {
      await mfaService.disable({
        endUserId: req.endUser!.id,
        application: req.application!,
      });
      return { success: true, data: { disabled: true } };
    },
  );
}
