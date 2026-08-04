/**
 * Operator MFA routes.
 *
 * setup → setup-confirm → (sign-in challenges fire from now on), plus disable.
 *
 * ## Why setup and disable both demand a current factor
 *
 * An enrolled operator authenticator is the one credential a stolen panel
 * access token does not carry, so the two routes that can remove it are the
 * two an attacker holding that token will reach for. Both were open:
 *
 *   - `/disable` required nothing at all — a session was sufficient.
 *   - `/setup` was worse, because it looked harmless. It resets
 *     `enrolledAt: null` on the existing credential, so calling it silently
 *     un-enrolls the operator's real authenticator and binds a new secret the
 *     attacker chose. Guarding only `/disable` would have left the same
 *     outcome one call to the left.
 *
 * So both step up through `assertTenantStepUp` with `requireMfaWhenEnrolled`,
 * which accepts ONLY a current TOTP or unused backup code once enrollment is
 * complete — deliberately not the account password, which a session thief may
 * well also have. This mirrors `mfaService.disable` on the end-user side.
 *
 * Neither demands anything when enrollment is NOT complete: first-time setup
 * has no factor to prove with, and cancelling a half-finished enrollment must
 * not be a dead end.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantMfaService } from './tenant-mfa.service.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { assertTenantStepUp } from '../../lib/step-up.js';
import { ok, okFlag, errs } from '../../lib/openapi.js';

/**
 * The 401/403 pair `requireTenantSession` (middleware/tenant-session.ts) produces, shared by
 * every route in this plugin.
 */
const TENANT_SESSION_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or TENANT_SESSION_INVALID — ' +
    'the session JWT is malformed, expired, or its operator no longer exists.',
  403: "TENANT_MEMBERSHIP_REVOKED — the session's workspace no longer has a live membership for this operator.",
} as const;

const CodeBody = z.object({ code: z.string().min(1).max(64) });

/** Optional step-up proof accepted on setup / disable. */
const ProofBody = z.object({
  code: z.string().min(1).max(64).optional(),
  password: z.string().min(1).max(256).optional(),
});

const proofJsonSchema = {
  type: 'object' as const,
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 64 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
};

/**
 * Demand a current factor before a change that would remove the operator's
 * enrolled authenticator. No-op when enrollment was never completed.
 */
async function stepUpIfEnrolled(
  tenantUserId: string,
  proof: { code?: string | undefined; password?: string | undefined },
  action: string,
): Promise<void> {
  if (!(await tenantMfaService.enrollmentComplete(tenantUserId))) return;
  await assertTenantStepUp({
    tenantUserId,
    proof,
    action,
    requireMfaWhenEnrolled: true,
    verifyMfaCode: (a) => tenantMfaService.verify(a),
  });
}

export async function tenantMfaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/status',
    {
      schema: {
        tags: ['Tenant · MFA'],
        security: [{ tenantSession: [] }],
        summary: 'MFA status for the operator',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                remainingBackupCodes: {
                  type: 'integer',
                  nullable: true,
                  description: '`null` when `enabled` is false.',
                },
              },
              required: ['enabled', 'remainingBackupCodes'],
            },
            'MFA enrollment status for the calling operator.',
          ),
          ...errs(TENANT_SESSION_ERRORS),
        },
      },
    },
    async (req) => ({ success: true, data: await tenantMfaService.status(req.tenantUser!.id) }),
  );

  app.post(
    '/setup',
    {
      // Code-guessing surface once a factor is enrolled — same cap as confirm.
      config: { rateLimit: authRateLimit(10) },
      // `code`/`password` are optional (first-time setup sends neither), so a
      // caller may POST no body at all. Fastify validates a missing body
      // against `{type:'object'}` and answers 400 "body must be object" — the
      // same trap that broke the end-user mfa/disable route.
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
      schema: {
        tags: ['Tenant · MFA'],
        security: [{ tenantSession: [] }],
        summary: 'Mint a new TOTP secret + 10 backup codes',
        description:
          'Returns the otpauth URI for QR + backup codes (one-time-show). Not enrolled until /setup-confirm.\n\n' +
          'When MFA is **already enrolled**, this is a credential change — re-enrolling ' +
          'unbinds the current authenticator — so it requires `code`: a current 6-digit ' +
          'authenticator code or an unused backup code. The account password is not accepted ' +
          'while an authenticator is enrolled. First-time setup requires nothing.',
        body: proofJsonSchema,
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                otpauthUrl: { type: 'string', description: 'otpauth:// URI — render as a QR code.' },
                backupCodes: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Ten one-time-use backup codes, shown only in this response.',
                },
                warning: { type: 'string' },
              },
              required: ['otpauthUrl', 'backupCodes', 'warning'],
            },
            'A new TOTP secret + backup codes. Not enrolled until POST /setup-confirm.',
          ),
          ...errs({
            400:
              'STEP_UP_UNAVAILABLE — the operator has neither a password nor MFA enrolled to ' +
              'prove identity with (only possible when re-enrolling over an existing factor).',
            401:
              TENANT_SESSION_ERRORS[401] +
              '; or STEP_UP_REQUIRED — re-enrolling over an existing authenticator requires a ' +
              'current code or unused backup code (only when already enrolled).',
            403: TENANT_SESSION_ERRORS[403],
            429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.',
          }),
        },
      },
    },
    async (req, reply) => {
      const proof = ProofBody.parse(req.body ?? {});
      await stepUpIfEnrolled(req.tenantUser!.id, proof, 're-enroll two-factor authentication');
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
        response: {
          200: okFlag('MFA enrollment confirmed.'),
          ...errs({
            400: 'MFA_NOT_INITIATED — POST /setup was not called first.',
            401: TENANT_SESSION_ERRORS[401],
            403: TENANT_SESSION_ERRORS[403],
            422: 'MFA_CODE_INVALID — the TOTP code did not verify.',
            429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.',
          }),
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
      config: { rateLimit: authRateLimit(10) },
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
      schema: {
        tags: ['Tenant · MFA'],
        security: [{ tenantSession: [] }],
        summary: 'Disable MFA for the operator',
        description:
          'Requires `code` — a current 6-digit authenticator code or an unused backup code. ' +
          'The account password is deliberately not accepted: someone holding a stolen ' +
          'session and the password is precisely who the second factor exists to stop. ' +
          'Cancelling a half-finished enrollment (never confirmed) requires nothing.',
        body: proofJsonSchema,
        response: {
          200: ok(
            {
              type: 'object',
              properties: { disabled: { type: 'boolean', enum: [true] } },
              required: ['disabled'],
            },
            'MFA is turned off for the operator.',
          ),
          ...errs({
            400:
              'STEP_UP_UNAVAILABLE — the operator has neither a password nor MFA enrolled to ' +
              'prove identity with (only possible when enrollment is already complete).',
            401:
              TENANT_SESSION_ERRORS[401] +
              '; or STEP_UP_REQUIRED — disabling requires a current authenticator code or ' +
              'unused backup code (only when enrollment is already complete).',
            403: TENANT_SESSION_ERRORS[403],
            429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.',
          }),
        },
      },
    },
    async (req) => {
      const proof = ProofBody.parse(req.body ?? {});
      await stepUpIfEnrolled(req.tenantUser!.id, proof, 'turn off two-factor authentication');
      await tenantMfaService.disable(req.tenantUser!.id);
      return { success: true, data: { disabled: true } };
    },
  );
}
