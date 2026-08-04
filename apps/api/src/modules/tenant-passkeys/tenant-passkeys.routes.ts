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
import { assertTenantStepUp } from '../../lib/step-up.js';
import { tenantMfaService } from '../tenant-mfa/tenant-mfa.service.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { ok, errs, ref } from '../../lib/openapi.js';

/**
 * The 401/403 pair `requireTenantSession` (middleware/tenant-session.ts) produces, shared by
 * every route in `tenantPasskeysAuthenticatedRoutes` below.
 */
const TENANT_SESSION_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or TENANT_SESSION_INVALID — ' +
    'the session JWT is malformed, expired, or its operator no longer exists.',
  403: "TENANT_MEMBERSHIP_REVOKED — the session's workspace no longer has a live membership for this operator.",
} as const;

// `tenantPasskeysService`'s `PasskeyRow` (`{id, credentialId, deviceName, lastUsedAt,
// createdAt}`) now matches the corrected `Passkey` component field-for-field — referenced
// directly via `ref('Passkey')` below instead of duplicating the shape here.

// `authenticateComplete` returns an `AuthSessionResult` verbatim (see tenant-passkeys.service.ts)
// — no `mfaRequired` field is added on top, unlike `tenant-auth.routes.ts`'s `shape()`. That is
// exactly the `OperatorSession` component's shape (`user`, `memberships`, `activeTenantId`,
// `activeRole`, plus the token pair), so this references `ref('OperatorSession')` directly at the
// call site rather than wrapping it in a local `allOf` — a previous pass here also declared an
// `mfaRequired: false` field on the response schema that the handler never actually sends, which
// `ref('OperatorSession')` alone does not claim.

/** Step-up proof accepted by `/passkeys/register/start`. Any one that verifies passes. */
const StepUpProofBody = z.object({
  password: z.string().min(1).max(256).optional(),
  code: z.string().min(1).max(64).optional(),
});

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
        response: {
          // NOTE: the handler wraps the array as `{passkeys: [...]}` with no page metadata —
          // an unbounded, growable collection with no pagination implemented. Documented with
          // the real field name rather than forcing okPage's items/page shape; see the report.
          200: ok(
            {
              type: 'object',
              properties: { passkeys: { type: 'array', items: ref('Passkey') } },
              required: ['passkeys'],
            },
            "The operator's registered passkeys.",
          ),
          ...errs(TENANT_SESSION_ERRORS),
        },
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
      // Enrolling an operator passkey is a persistent-takeover primitive, and
      // this route had no second demand of any kind — a panel access token was
      // enough. An operator passkey signs its holder straight in
      // (`authenticateComplete` mints the session; there is no MFA challenge
      // after it), and nothing the victim can do removes it: changing the
      // password does not, signing out everywhere does not. They would have to
      // notice a stranger's row in GET /passkeys.
      //
      // The end-user surface reached this conclusion first and
      // `/auth/passkey/register/start` has demanded a step-up since; this is
      // the same control on the operator side. Proof is the account password OR
      // a current authenticator code — deliberately either, unlike the MFA
      // routes, because enrolment ADDS a credential rather than removing the
      // one being proved.
      config: { rateLimit: authRateLimit(10) },
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
      schema: {
        tags: ['Tenant · Passkeys'],
        security: [{ tenantSession: [] }],
        summary: 'Begin a registration ceremony for the current operator',
        description:
          'Requires a step-up proof: `password` (the operator account password) or `code` ' +
          '(a current authenticator or unused backup code). A passkey signs an operator in ' +
          'with no password and no second factor, so a stolen panel session alone must not ' +
          'be able to enroll one.',
        body: {
          type: 'object',
          properties: {
            password: { type: 'string', minLength: 1, maxLength: 256 },
            code: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                options: {
                  type: 'object',
                  description:
                    'WebAuthn `PublicKeyCredentialCreationOptionsJSON` (from ' +
                    '@simplewebauthn/server): `rp`, `user`, `challenge`, `pubKeyCredParams`, ' +
                    '`timeout`, `excludeCredentials`, `authenticatorSelection`, `attestation`, ' +
                    '`extensions`. Pass verbatim to `navigator.credentials.create()`.',
                },
                expectedChallenge: {
                  type: 'string',
                  description: 'Echo this back to /passkeys/register/complete.',
                },
              },
              required: ['options', 'expectedChallenge'],
            },
            'WebAuthn registration ceremony options.',
          ),
          ...errs({
            400:
              'STEP_UP_UNAVAILABLE — the operator has neither a password nor MFA enrolled to ' +
              'prove identity with.',
            401:
              TENANT_SESSION_ERRORS[401] +
              '; or STEP_UP_REQUIRED — enrolling a passkey requires the account password or a ' +
              'current authenticator/backup code.',
            403: TENANT_SESSION_ERRORS[403],
            429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.',
          }),
        },
      },
    },
    async (req) => {
      const proof = StepUpProofBody.parse(req.body ?? {});
      await assertTenantStepUp({
        tenantUserId: req.tenantUser!.id,
        proof,
        action: 'enroll a passkey',
        verifyMfaCode: (a) => tenantMfaService.verify(a),
      });
      const result = await tenantPasskeysService.registerStart(req.tenantUser!.id);
      return { success: true, data: result };
    },
  );

  app.post(
    '/passkeys/register/complete',
    {
      // No step-up here, and that is not an oversight: it happened at
      // /register/start and `consumeChallenge` binds this call to that
      // ceremony. The challenge is single-use and scoped to this operator, so
      // this request must have come from a start that already proved identity.
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
        response: {
          201: ok(ref('Passkey'), 'The stored passkey.'),
          ...errs({
            400: 'PASSKEY_REGISTRATION_FAILED — the WebAuthn ceremony did not verify.',
            401:
              TENANT_SESSION_ERRORS[401] +
              '; or WEBAUTHN_CHALLENGE_INVALID — the challenge is unknown, expired, already ' +
              'used, or does not match this ceremony.',
            403: TENANT_SESSION_ERRORS[403],
            409: 'PASSKEY_ALREADY_REGISTERED — that credential is already registered.',
          }),
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
        response: {
          200: ok(
            {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
            'Id of the removed passkey.',
          ),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            404: 'PASSKEY_NOT_FOUND — no passkey with that id owned by the calling operator.',
          }),
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
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                options: {
                  type: 'object',
                  description:
                    'WebAuthn `PublicKeyCredentialRequestOptionsJSON` (from ' +
                    '@simplewebauthn/server): `challenge`, `timeout`, `rpId`, ' +
                    '`allowCredentials`, `userVerification`, `extensions`. Usernameless — ' +
                    '`allowCredentials` is empty. Pass verbatim to ' +
                    '`navigator.credentials.get()`.',
                },
                expectedChallenge: {
                  type: 'string',
                  description: 'Echo this back to /passkeys/authenticate/complete.',
                },
              },
              required: ['options', 'expectedChallenge'],
            },
            'WebAuthn authentication ceremony options.',
          ),
          ...errs({ 429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.' }),
        },
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
        response: {
          200: ok(ref('OperatorSession'), 'The new operator session. No MFA challenge follows a passkey sign-in.'),
          ...errs({
            400: 'PASSKEY_RESPONSE_INVALID — the WebAuthn response is missing its credential id.',
            401:
              'WEBAUTHN_CHALLENGE_INVALID — the challenge is unknown, expired, already used, ' +
              'or does not match this ceremony; or PASSKEY_UNKNOWN — no passkey with that ' +
              'credential id is registered; or PASSKEY_AUTHENTICATION_FAILED — the ceremony ' +
              'did not verify.',
            403: 'NO_TENANT_MEMBERSHIPS — the operator has no workspace memberships.',
          }),
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
