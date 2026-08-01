/**
 * End-user MFA routes.
 *
 * setup → confirm → (sign-in challenges fire from now on)
 *
 * The sign-in MFA challenge is NOT here — sign-in lives in `modules/auth`. An
 * enrolled user gets an `mfaChallengeToken` instead of a session, exchanged at
 * `POST /api/v1/auth/mfa-verify`. So no session exists until the second factor
 * passes.
 *
 * `POST /mfa/challenge` in this module is a different thing: it sits behind
 * `requireUserSession`, so it is step-up for an already-signed-in user, and
 * cannot complete a sign-in.
 */

import type { FastifyInstance } from 'fastify';
import type { Application } from '@prisma/client';
import { z } from 'zod';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { mfaService } from './mfa.service.js';
import { RekeyError } from '../../lib/error.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { authRateLimit } from '../../lib/rate-limit.js';

const CodeBody = z.object({ code: z.string().min(1).max(64) });

/** End-user MFA is gated by the Application's `authConfig.mfa` policy. */
function mfaPolicy(application: Application): 'off' | 'optional' | 'required' {
  return AuthConfigSchema.parse(application.authConfig).mfa;
}
function assertMfaEnabled(application: Application): void {
  if (mfaPolicy(application) === 'off') {
    throw new RekeyError({
      statusCode: 403,
      code: 'MFA_NOT_ENABLED',
      message: 'Two-factor authentication is not enabled for this Application.',
      fix: 'An operator can enable it in the panel: Application → Auth → Two-factor (set to Optional or Required).',
    });
  }
}

export async function mfaRoutes(app: FastifyInstance): Promise<void> {
  // Accepts the publishable key, like `POST /auth/mfa-verify` (the sign-in MFA
  // challenge) already does. `requireUserSession` is the authorizer for every
  // route here — each one acts only on `req.endUser`. Secret-only enrollment
  // meant a browser-only app could be *challenged* for MFA it could never
  // *enroll*, and `authConfig.mfa='required'` hard-stopped those users.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:write'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/status',
    {
      schema: {
        tags: ['Public · MFA'],
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
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
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        summary: 'Mint a new TOTP secret + 10 backup codes (one-time-show). Not enrolled until /setup-confirm.',
      },
    },
    async (req, reply) => {
      assertMfaEnabled(req.application!);
      const result = await mfaService.setup({
        endUser: { ...req.endUser!, passwordHash: null } as never,
        // Keep "Rekey" branded — could be made app-aware via Application.name later.
        issuer: 'Rekey',
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
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
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
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
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
      config: { rateLimit: authRateLimit(10) },
      // `code` is optional, so a caller with nothing to send may POST with no
      // body at all — which is exactly what `disableMfa(accessToken)` in
      // @rekey.dev/node does (it passes `undefined`, so the transport sets neither
      // Content-Type nor body). Declaring `schema.body` makes Fastify validate
      // `undefined` against `{type:'object'}` and answer 400 "body must be
      // object", which would have broken every published 1.0.0 SDK caller.
      // Normalising here keeps the schema (and therefore the /docs entry for
      // `code`) while still accepting the bodyless shape.
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
      schema: {
        tags: ['Public · MFA'],
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        summary: 'Disable MFA for the current user',
        description:
          'Browser callers (publishable key) must send `code` — a current TOTP or an unused backup code. ' +
          'Server-side callers using an Application secret key are not required to, preserving the original contract.',
        body: {
          type: 'object',
          properties: { code: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req) => {
      const body = (req.body ?? {}) as { code?: unknown };
      await mfaService.disable({
        endUserId: req.endUser!.id,
        application: req.application!,
        requireCode: req.authKind === 'publishable',
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
      });
      return { success: true, data: { disabled: true } };
    },
  );
}
