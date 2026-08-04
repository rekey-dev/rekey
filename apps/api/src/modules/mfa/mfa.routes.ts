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
import { refuseWhileImpersonating } from '../../middleware/impersonation.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { ok, okFlag, errs } from '../../lib/openapi.js';

const CodeBody = z.object({ code: z.string().min(1).max(64) });

/**
 * Errors from `requirePublishableOrSecretKey` + `requireScope('auth:write')` +
 * `requireUserSession` — every route in this module runs all three as
 * `onRequest` hooks.
 */
const USER_SESSION_ERRORS = {
  401:
    'API_KEY_MISSING — no `Authorization: Bearer` header; or API_KEY_INVALID — the secret ' +
    'key is unknown, revoked, or expired; or PUBLISHABLE_KEY_INVALID — the publishable key ' +
    'is unknown or was rotated out; or USER_TOKEN_MISSING — no `X-Rekey-User-Token` header; ' +
    'or USER_TOKEN_INVALID — the user token is invalid, expired, or wrongly signed; or ' +
    'USER_TOKEN_WRONG_APPLICATION — the token was issued by a different Application; or ' +
    'IMPERSONATION_SESSION_ENDED — the impersonation session behind this token has ended.',
  403:
    'IP_NOT_ALLOWED — caller IP is outside the secret key\'s IP allowlist; or ' +
    'ORIGIN_NOT_ALLOWED — the browser `Origin` is outside the publishable key\'s CORS ' +
    'allowlist; or API_KEY_SCOPE_INSUFFICIENT — the secret key lacks the `auth:write` scope.',
  429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
} as const;

/**
 * Added on every mutating route (all but GET /status) by the module's
 * `preHandler` hook — `refuseWhileImpersonating`.
 */
const IMPERSONATION_DESC =
  "IMPERSONATION_ACTION_FORBIDDEN — an impersonated session cannot change this account's " +
  'two-factor settings.';

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
  // Every mutating route here rebinds or removes the user's second factor, and
  // the effect outlives the 5-minute impersonation token permanently — an
  // operator could point the victim's MFA at their own authenticator and the
  // victim would see only "my 2FA changed". `/status` stays readable; it is the
  // question a support session is actually asking.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET') return;
    await refuseWhileImpersonating("change this account's two-factor settings")(req, reply);
  });

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
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                remainingBackupCodes: {
                  type: 'integer',
                  nullable: true,
                  description: 'Null when MFA is not enabled.',
                },
                policy: {
                  type: 'string',
                  enum: ['off', 'optional', 'required'],
                  description: "The Application's `authConfig.mfa` policy.",
                },
              },
              required: ['enabled', 'remainingBackupCodes', 'policy'],
            },
            'MFA status for the current user.',
          ),
          ...errs(USER_SESSION_ERRORS),
        },
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
      // Rate-limited like the other code-bearing routes here: once a factor is
      // enrolled this accepts a `code`, so it becomes a guessing surface.
      config: { rateLimit: authRateLimit(10) },
      // `code` is optional (first-time setup sends none), so a browser caller
      // may POST no body. Same normalisation as /disable — see the note there
      // for why declaring `schema.body` alone would 400 every existing SDK.
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
      schema: {
        tags: ['Public · MFA'],
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        summary: 'Mint a new TOTP secret + 10 backup codes (one-time-show). Not enrolled until /setup-confirm.',
        description:
          'When MFA is **already enrolled**, browser callers (publishable key) must send ' +
          '`code` — a current TOTP or an unused backup code. Re-running setup resets ' +
          'enrollment, so without that guard a stolen access token could rebind the second ' +
          'factor to an authenticator the attacker controls, which is the same outcome ' +
          '/mfa/disable refuses. First-time setup requires nothing, and server-side callers ' +
          'using a secret key are never required to (their backend is the gate).',
        body: {
          type: 'object',
          properties: { code: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                otpauthUrl: { type: 'string', description: 'otpauth:// URI — render as a QR code.' },
                backupCodes: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Plaintext one-time backup codes. Shown exactly ONCE — only their SHA-256 ' +
                    'hashes are stored, so they cannot be recovered later.',
                },
                warning: { type: 'string' },
              },
              required: ['otpauthUrl', 'backupCodes', 'warning'],
            },
            'A new TOTP secret + 10 backup codes. Not enrolled until POST /setup-confirm.',
          ),
          ...errs({
            ...USER_SESSION_ERRORS,
            401: `${USER_SESSION_ERRORS[401]}; or MFA_CODE_INVALID — re-enrolling from a browser over an existing enrollment requires a current TOTP or backup code.`,
            403: `${USER_SESSION_ERRORS[403]}; or MFA_NOT_ENABLED — this Application's authConfig.mfa policy is "off"; or ${IMPERSONATION_DESC}`,
          }),
        },
      },
    },
    async (req, reply) => {
      assertMfaEnabled(req.application!);
      // Only for a browser caller, and only over a COMPLETED enrollment —
      // matching `mfaService.disable`'s posture field for field. `verify`
      // returns false for `enrolledAt: null`, so demanding a code
      // unconditionally would make restarting an abandoned enrollment
      // impossible.
      if (req.authKind === 'publishable' && (await mfaService.isEnrolled(req.endUser!.id))) {
        const body = (req.body ?? {}) as { code?: unknown };
        const ok =
          typeof body.code === 'string'
            ? await mfaService.verify({ endUserId: req.endUser!.id, code: body.code })
            : false;
        if (!ok) {
          // Same code + message shape as /disable: clients already switch on
          // MFA_CODE_INVALID, and this is the same demand for the same reason.
          throw new RekeyError({
            statusCode: 401,
            code: 'MFA_CODE_INVALID',
            message:
              'Re-enrolling MFA from a browser requires a current authenticator or backup code.',
            fix: 'Send `code` with a current 6-digit TOTP or an unused backup code. Server-side callers using a secret key are not required to.',
          });
        }
      }
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
        response: {
          200: okFlag('MFA is now enrolled. A confirmation notification was also dispatched.'),
          ...errs({
            400: 'MFA_NOT_INITIATED — call POST /mfa/setup before /mfa/setup-confirm.',
            ...USER_SESSION_ERRORS,
            403: `${USER_SESSION_ERRORS[403]}; or ${IMPERSONATION_DESC}`,
            422: 'MFA_CODE_INVALID — the TOTP code did not verify.',
          }),
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
        response: {
          // Not okFlag(): unlike the other routes here, a wrong code is a
          // normal 200 `{ok: false}`, not an error — okFlag()'s `ok` is
          // pinned to the literal `true`.
          200: ok(
            {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
            },
            'Whether the code verified. Backup codes are single-use — consumed on success.',
          ),
          ...errs({
            ...USER_SESSION_ERRORS,
            403: `${USER_SESSION_ERRORS[403]}; or ${IMPERSONATION_DESC}`,
            429: `${USER_SESSION_ERRORS[429]}; or MFA_TOO_MANY_ATTEMPTS — too many recent failed attempts for this user (separate, tighter limiter than the general RATE_LIMITED cap).`,
          }),
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
        response: {
          200: ok(
            {
              type: 'object',
              properties: { disabled: { type: 'boolean', enum: [true] } },
              required: ['disabled'],
            },
            'MFA disabled.',
          ),
          ...errs({
            ...USER_SESSION_ERRORS,
            401: `${USER_SESSION_ERRORS[401]}; or MFA_CODE_INVALID — browser callers must send a current TOTP or backup code to disable an enrolled factor.`,
            403: `${USER_SESSION_ERRORS[403]}; or ${IMPERSONATION_DESC}`,
          }),
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
