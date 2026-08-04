import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authService } from './auth.service.js';
import {
  requireApiKey,
  requirePublishableOrSecretKey,
  requireScope,
} from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { assertStepUp } from '../../lib/step-up.js';
import { refuseWhileImpersonating } from '../../middleware/impersonation.js';
import { mfaService } from '../mfa/mfa.service.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import type { SecurityEventType } from '@rekey.dev/shared-types';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { ok, okPage, okFlag, errs, ref, type JsonSchema } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';

// ---------------------------------------------------------------------------
// Shared error fragments
//
// Every route in `authRoutes` (the public-bootstrap plugin) sits behind
// `requirePublishableOrSecretKey` + `requireScope('auth:write')`. Every route
// in `authenticatedAuthRoutes` sits behind those two PLUS `requireUserSession`
// — see middleware/api-key-auth.ts and middleware/user-session.ts for the
// exact throws these hooks produce.
// ---------------------------------------------------------------------------

const BOOTSTRAP_401 =
  'API_KEY_MISSING — no `Authorization: Bearer` header; or API_KEY_INVALID — the secret key ' +
  'is unknown, revoked, or expired; or PUBLISHABLE_KEY_INVALID — the publishable key is ' +
  "unknown or has rotated out of its grace window.";
const BOOTSTRAP_403 =
  "IP_NOT_ALLOWED — a secret-key caller's IP is outside the Application's `ipAllowlist`; or " +
  "ORIGIN_NOT_ALLOWED — a publishable-key caller's `Origin` is outside `corsOrigins`; or " +
  'API_KEY_SCOPE_INSUFFICIENT — the secret key lacks the `auth:write` scope.';
const RATE_LIMITED = 'RATE_LIMITED — too many requests for this window. Honour the `Retry-After` header.';

/** Shared by every route in the public-bootstrap plugin (`authRoutes`). */
const BOOTSTRAP_ERRORS = { 401: BOOTSTRAP_401, 403: BOOTSTRAP_403, 429: RATE_LIMITED } as const;

const USER_SESSION_401 =
  BOOTSTRAP_401 +
  ' Or USER_TOKEN_MISSING — no `X-Rekey-User-Token` header; or USER_TOKEN_INVALID — the user ' +
  'token is invalid, expired, or signed with a different secret; or ' +
  'USER_TOKEN_WRONG_APPLICATION — the token was issued by a different Application; or ' +
  'IMPERSONATION_SESSION_ENDED — the impersonation session backing this token has ended.';

/** Shared by every route in the authenticated plugin (`authenticatedAuthRoutes`). */
const AUTHENTICATED_ERRORS = {
  401: USER_SESSION_401,
  403: BOOTSTRAP_403,
  404: 'END_USER_NOT_FOUND — the end-user behind this session no longer exists in this Application.',
  410: 'END_USER_ERASED — this end-user was erased (GDPR) and can no longer authenticate.',
  429: RATE_LIMITED,
} as const;

const IMPERSONATION_403 =
  BOOTSTRAP_403 +
  ' Or IMPERSONATION_ACTION_FORBIDDEN — an impersonation session cannot rebind a credential ' +
  '(password, MFA, or passkey).';

/** `navigator.credentials.{get,create}` options — opaque to the server, so modelled loosely. */
const WEBAUTHN_OPTIONS: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  description: 'WebAuthn ceremony options. Pass verbatim to the browser API.',
};

/**
 * Extract device fingerprint from a Fastify request for session tracking.
 * Returns `null` fields when the headers are missing; the refresh-token
 * lib treats nulls as "unknown" and the panel renders accordingly.
 */
function deviceContext(req: FastifyRequest): { userAgent: string | null; ip: string | null } {
  const ua = req.headers['user-agent'];
  return {
    userAgent: typeof ua === 'string' && ua.length > 0 ? ua : null,
    ip: req.ip || null,
  };
}

/**
 * Append an end-user activity event to the security-events log. Fire-and-forget
 * + best-effort (the writer swallows its own errors) so logging never breaks the
 * auth action. Scoped to the calling Application + its tenant so it surfaces in
 * the operator's per-app Activity feed.
 */
function recordEndUserEvent(
  req: FastifyRequest,
  type: SecurityEventType,
  endUserId: string | null,
  metadata?: Record<string, unknown>,
): void {
  const { ip, userAgent } = requestContext(req);
  void recordSecurityEvent({
    type,
    actorType: 'end_user',
    actorId: endUserId,
    tenantId: req.application?.tenantId ?? null,
    applicationId: req.application?.id ?? null,
    ip,
    userAgent,
    ...(metadata !== undefined && { metadata }),
  });
}

const SignUpBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  metadata: z.record(z.unknown()).optional(),
});

const SignInBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const RefreshBody = z.object({
  refreshToken: z.string().min(1).max(512),
});

const SignOutBody = z.object({
  refreshToken: z.string().min(1).max(512),
});

// Permissive URL check — accepts `{token}` placeholders that Ajv's
// `format: uri` would reject. Zod's `.url()` parses with the WHATWG URL
// constructor which tolerates `{` `}` in path/query.
const TokenizedUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }, 'Must be a valid URL.');

const ForgotPasswordBody = z.object({
  email: z.string().email().max(254),
  /** Optional URL with `{token}` substituted in the email body. */
  resetUrl: TokenizedUrl.optional(),
});

const VerifyEmailBody = z.object({
  token: z.string().min(1).max(512),
});

const SendVerificationBody = z.object({
  verifyUrl: TokenizedUrl.optional(),
});

/** Same body as above plus the address, since there is no session to read it from. */
const ResendVerificationBody = z.object({
  email: z.string().email().max(254),
  verifyUrl: TokenizedUrl.optional(),
});

const MagicLinkRequestBody = z.object({
  email: z.string().email().max(254),
  signInUrl: TokenizedUrl.optional(),
});

const MagicLinkVerifyBody = z.object({
  token: z.string().min(1).max(512),
});

const PasskeyAuthStartBody = z.object({
  email: z.string().email().max(254).optional(),
});

const PasskeyAuthCompleteBody = z.object({
  // We accept the entire WebAuthn AuthenticationResponseJSON as an opaque
  // record; SimpleWebAuthn's verifier validates the shape.
  response: z.record(z.unknown()),
  expectedChallenge: z.string().min(1).max(1024),
});

const PasskeyRegisterCompleteBody = z.object({
  response: z.record(z.unknown()),
  expectedChallenge: z.string().min(1).max(1024),
  deviceName: z.string().min(1).max(120).optional(),
});

const ResetPasswordBody = z.object({
  token: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(256),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

const MfaVerifyBody = z.object({
  mfaChallengeToken: z.string().min(1).max(2048),
  code: z.string().min(1).max(64),
});

export function shapeAuthResult(result: import('./auth.service.js').AuthResult): {
  mfaRequired: false;
  endUser: import('./auth.service.js').PublicEndUser;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
} {
  return {
    mfaRequired: false,
    endUser: result.endUser,
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
  };
}

/**
 * Shape a sign-in outcome for the wire. The discriminator `mfaRequired`
 * tells SDKs whether to treat the response as a finished session or to
 * prompt for the second factor and POST to /auth/mfa-verify.
 *
 * Exported so OAuth callback and any future flows (magic link, passkey)
 * shape responses identically.
 */
export function shapeSignInOutcome(
  outcome: import('./auth.service.js').SignInOutcome,
): Record<string, unknown> {
  if (outcome.mfaRequired) {
    return {
      mfaRequired: true,
      endUser: outcome.endUser,
      mfaChallengeToken: outcome.mfaChallengeToken,
      mfaChallengeExpiresAt: outcome.mfaChallengeExpiresAt.toISOString(),
    };
  }
  return {
    ...shapeAuthResult(outcome),
    ...(outcome.mfaEnrollmentRequired && { mfaEnrollmentRequired: true }),
  };
}

/**
 * EndUser **public-bootstrap** auth endpoints (sign-up, sign-in, magic link,
 * passkey authenticate, refresh, password reset).
 *
 * Gated by `requirePublishableOrSecretKey` — NOT `requireApiKey`. These are the
 * routes a browser-only app must reach before any user token exists, so they
 * accept the Application's **publishable** key (`rp_pub_…`) as well as a
 * server-side secret key. The key only says *which Application* is calling; the
 * user still proves their own identity per route (password, passkey assertion,
 * or an emailed single-use token).
 *
 * The authenticated half of the end-user auth surface — sessions, token
 * revocation, password change, MFA enrollment — lives in
 * `authenticatedAuthRoutes` below. It takes the same two key kinds and adds
 * `requireUserSession`, which is the actual authorizer there. Passkey ENROLLMENT
 * additionally demands a step-up proof from publishable callers (`lib/step-up.ts`).
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public-bootstrap auth surface (sign-up, sign-in, magic-link, passkey
  // authenticate, refresh, password-reset). These are the routes a browser-only
  // app must call before any user token exists, so they accept the Application's
  // publishable key (`rp_pub_*`) as well as a server secret key. The credential
  // only identifies the app — the user still proves identity (password/passkey/
  // emailed token) per route.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  // All routes in this plugin mutate auth state (create users, mint sessions,
  // change passwords). Require `auth:write` (which the `*` mint default
  // also satisfies via SCOPE_IMPLICATIONS; publishable requests are
  // pre-authorized by route membership).
  app.addHook('onRequest', requireScope('auth:write'));

  app.post(
    '/sign-up',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Create an end-user via email + password',
        description:
          'Creates a new EndUser in the calling Application and issues a JWT. ' +
          'Email is unique per Application, not globally. Unless the Application turns ' +
          '`authConfig.sendVerificationEmailOnSignUp` off, the verification link goes out ' +
          'alongside the welcome mail — both are best-effort and neither can fail the sign-up. ' +
          'With `authConfig.requireEmailVerification` on this returns 403 `EMAIL_NOT_VERIFIED` ' +
          'instead of a session: the account IS created and the link IS sent (that switch ' +
          'overrides the send setting), but no token is issued until the address is confirmed.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
            metadata: {
              type: 'object',
              additionalProperties: true,
              description: 'Free-form per-app metadata (display name, avatar, custom fields).',
            },
          },
        },
        response: {
          201: ok(ref('AuthResult'), 'The created end-user plus a fresh session.'),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            400:
              'AUTH_METHOD_DISABLED — password sign-up is disabled for this Application; or ' +
              'PASSWORD_TOO_SHORT — shorter than `authConfig.passwordMinLength`; or ' +
              'PASSWORD_BREACHED — the password appears in a known breach corpus; or ' +
              'METADATA_TOO_LARGE — `metadata` exceeds the 16KB limit; or ' +
              'METADATA_KEY_RESERVED — a publishable caller set the reserved `metadata.oidc` key.',
            403:
              BOOTSTRAP_403 +
              ' Also: SIGNUP_DISABLED — public sign-up is off for this Application; or ' +
              'SIGNUP_REQUIRES_SECRET_KEY — the Application only allows creating end-users with ' +
              "a secret key; or TENANT_QUOTA_EXCEEDED — the workspace's end-user limit is " +
              'reached; or EMAIL_NOT_VERIFIED — `authConfig.requireEmailVerification` is on, so ' +
              'no session is issued (the account IS created and the verification email IS sent).',
            409: 'EMAIL_ALREADY_EXISTS — another end-user in this Application already uses that email.',
          }),
        },
      },
    },
    async (req, reply) => {
      const body = SignUpBody.parse(req.body);
      const result = await authService.signUp({
        application: req.application!,
        email: body.email,
        password: body.password,
        ...(body.metadata !== undefined && { metadata: body.metadata }),
        device: deviceContext(req),
        // Signup policy: a `secret_only` app refuses creation via a pub key.
        ...(req.authKind !== undefined && { authKind: req.authKind }),
      });
      recordEndUserEvent(req, 'user.signed_up', result.endUser.id);
      return reply.status(201).send({ success: true, data: shapeAuthResult(result) });
    },
  );

  app.post(
    '/sign-in',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Authenticate an existing end-user with email + password',
        description:
          'Verifies the password and issues a JWT. Returns 401 INVALID_CREDENTIALS for ' +
          'any auth failure (wrong email, wrong password, or sign-up via different method) — ' +
          'we never disclose which. When the Application sets ' +
          '`authConfig.requireEmailVerification`, a correct password on an unconfirmed ' +
          'address returns 403 EMAIL_NOT_VERIFIED instead, so your app can prompt the user ' +
          'to check their inbox rather than re-enter a password that is already right.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: ok(
            ref('SignInOutcome'),
            'A finished session, or an MFA challenge when the user has a second factor enrolled.',
          ),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            400: 'AUTH_METHOD_DISABLED — password sign-in is disabled for this Application.',
            401:
              BOOTSTRAP_401 +
              ' Or INVALID_CREDENTIALS — the email or password is wrong (we never disclose which).',
            403: BOOTSTRAP_403 + ' Or EMAIL_NOT_VERIFIED — the password was correct but the address is unconfirmed.',
            429:
              RATE_LIMITED +
              ' Or TOO_MANY_FAILED_ATTEMPTS — this (Application, email) pair is locked out after ' +
              'repeated failures; see `retryAfterSeconds`.',
          }),
        },
      },
    },
    async (req) => {
      const body = SignInBody.parse(req.body);
      const outcome = await authService.signIn({
        application: req.application!,
        email: body.email,
        password: body.password,
        device: deviceContext(req),
      });
      if (!outcome.mfaRequired) {
        recordEndUserEvent(req, 'user.signed_in', outcome.endUser.id, { via: 'password' });
      }
      return { success: true, data: shapeSignInOutcome(outcome) };
    },
  );

  app.post(
    '/mfa-verify',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Exchange an MFA challenge token + TOTP/backup code for a session',
        description:
          'Used after /sign-in or OAuth callback returns `mfaRequired: true`. The challenge token is short-lived (5 minutes) and bound to (endUser, application). On success returns the same shape as /sign-in when MFA is not required.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['mfaChallengeToken', 'code'],
          properties: {
            mfaChallengeToken: { type: 'string', minLength: 1, maxLength: 2048 },
            code: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: {
          200: ok(ref('AuthResult'), 'A finished session.'),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            401:
              BOOTSTRAP_401 +
              ' Or MFA_CHALLENGE_INVALID — the challenge token is invalid or expired; or ' +
              'MFA_CHALLENGE_WRONG_APPLICATION — issued for a different Application; or ' +
              'MFA_CODE_INVALID — the TOTP/backup code did not verify.',
          }),
        },
      },
    },
    async (req) => {
      const body = MfaVerifyBody.parse(req.body);
      const result = await authService.verifyMfaChallenge({
        application: req.application!,
        mfaChallengeToken: body.mfaChallengeToken,
        code: body.code,
        device: deviceContext(req),
      });
      recordEndUserEvent(req, 'user.signed_in', result.endUser.id, { via: 'mfa' });
      return { success: true, data: shapeAuthResult(result) };
    },
  );

  app.post(
    '/refresh',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Exchange a refresh token for a new {access, refresh} pair',
        description:
          'The presented refresh token is revoked atomically with issuing the replacement. ' +
          'A presented-but-revoked token is treated as a replay and rejected with REFRESH_TOKEN_REUSED.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(ref('AuthResult'), 'A fresh {access, refresh} pair.'),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            401:
              BOOTSTRAP_401 +
              ' Or REFRESH_TOKEN_INVALID — the token is unknown or not a session-kind token; or ' +
              'REFRESH_TOKEN_REUSED — a rotated-out token was replayed (every session for this ' +
              'user has been revoked as a precaution); or REFRESH_TOKEN_REVOKED — this session ' +
              'was revoked; or REFRESH_TOKEN_EXPIRED — the token has expired; or ' +
              'REFRESH_TOKEN_WRONG_APPLICATION — the token belongs to a different Application.',
            403: BOOTSTRAP_403 + ' Or EMAIL_NOT_VERIFIED — re-checked on every refresh.',
            410: 'END_USER_ERASED — this end-user was erased (GDPR) since the token was issued.',
          }),
        },
      },
    },
    async (req) => {
      const body = RefreshBody.parse(req.body);
      const result = await authService.refresh(req.application!, body.refreshToken);
      return { success: true, data: shapeAuthResult(result) };
    },
  );

  app.post(
    '/sign-out',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Revoke a refresh token',
        description:
          'Idempotent. Returns 200 even for unknown tokens — we don\'t disclose whether the token existed.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(
            { type: 'object', properties: { signedOut: { type: 'boolean', enum: [true] } }, required: ['signedOut'] },
            'Always {signedOut: true} — we do not disclose whether the token existed.',
          ),
          ...errs({ ...BOOTSTRAP_ERRORS }),
        },
      },
    },
    async (req) => {
      const body = SignOutBody.parse(req.body);
      await authService.signOut(body.refreshToken);
      return { success: true, data: { signedOut: true } };
    },
  );

  // -- Password reset (no user JWT — the whole point is the user can't sign in) ----

  app.post(
    '/forgot-password',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Request a password-reset token for an email',
        description:
          'Always returns 200 with `{ delivered: boolean, emailSent: boolean, resetToken: string|null }`. ' +
          'Never discloses whether the email exists. When the Application has email transport ' +
          'configured (BYO Resend or RESEND_DEFAULT_*), the email is sent and `resetToken` is null. ' +
          'Otherwise the legacy contract applies — caller forwards `resetToken` via their own provider.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            resetUrl: { type: 'string', maxLength: 2048 },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              description:
                'Never discloses whether the email exists. `resetToken` is non-null only when the ' +
                'Application has no email transport configured (legacy contract) — a publishable ' +
                'caller never receives it.',
              properties: {
                delivered: { type: 'boolean' },
                emailSent: { type: 'boolean' },
                resetToken: { type: 'string', nullable: true },
              },
              required: ['delivered', 'emailSent', 'resetToken'],
            },
            'Always 200; see field semantics.',
          ),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            400: 'AUTH_METHOD_DISABLED — password sign-in is disabled for this Application.',
          }),
        },
      },
    },
    async (req) => {
      const body = ForgotPasswordBody.parse(req.body);
      const result = await authService.requestPasswordReset({
        application: req.application!,
        email: body.email,
        ...(body.resetUrl !== undefined && { resetUrl: body.resetUrl }),
        // Gates the raw-token fallback: a publishable key must never receive it.
        ...(req.authKind !== undefined && { authKind: req.authKind }),
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/magic-link/request',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Request a magic-link sign-in email for an address',
        description:
          'Enumeration-safe: returns the same shape whether the email exists or not. ' +
          'When the Application has email transport configured, the link is sent and ' +
          '`magicLinkToken` is null. Otherwise the raw token is returned for the caller ' +
          'to forward via their own provider. Honours `authConfig.signupEnabled` — when ' +
          'disabled, magic links for new emails are silently refused (same enumeration-safe shape).',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            signInUrl: { type: 'string', maxLength: 2048 },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              description:
                'Enumeration-safe: same shape whether the email exists or not. `magicLinkToken` ' +
                'is non-null only when the Application has no email transport configured — a ' +
                'publishable caller never receives it (it IS a session).',
              properties: {
                delivered: { type: 'boolean' },
                emailSent: { type: 'boolean' },
                magicLinkToken: { type: 'string', nullable: true },
              },
              required: ['delivered', 'emailSent', 'magicLinkToken'],
            },
            'Always 200; see field semantics.',
          ),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            400: 'AUTH_METHOD_DISABLED — magic-link sign-in is disabled for this Application.',
          }),
        },
      },
    },
    async (req) => {
      const body = MagicLinkRequestBody.parse(req.body);
      const result = await authService.requestMagicLink({
        application: req.application!,
        email: body.email,
        ...(body.signInUrl !== undefined && { signInUrl: body.signInUrl }),
        // Signup policy: gates new-user link issuance under `secret_only`.
        ...(req.authKind !== undefined && { authKind: req.authKind }),
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/magic-link/verify',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Consume a magic-link token + complete sign-in',
        description:
          'Single-use, 15-minute lifetime. Returns the same `SignInOutcome` shape as ' +
          '/sign-in — MFA-enrolled users get a challenge token; otherwise a full session. ' +
          'For tokens issued when the email had no account yet, the EndUser is created ' +
          'atomically with the consume (sign-up must be enabled on the Application).',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(ref('SignInOutcome'), 'A finished session, or an MFA challenge.'),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            400: 'AUTH_METHOD_DISABLED — magic-link sign-in is disabled for this Application.',
            401:
              BOOTSTRAP_401 +
              ' Or MAGIC_LINK_INVALID — the token is unknown; or MAGIC_LINK_USED — already ' +
              'consumed; or MAGIC_LINK_EXPIRED — the 15-minute window passed; or ' +
              'MAGIC_LINK_WRONG_APPLICATION — issued for a different Application; or ' +
              'MAGIC_LINK_STALE — the account email changed since the token was issued.',
            403:
              BOOTSTRAP_403 +
              ' Also (new-user tokens only): SIGNUP_DISABLED — public sign-up is off; or ' +
              'SIGNUP_REQUIRES_SECRET_KEY — this Application only allows creating end-users ' +
              "with a secret key; or TENANT_QUOTA_EXCEEDED — the workspace's end-user limit is reached.",
          }),
        },
      },
    },
    async (req) => {
      const body = MagicLinkVerifyBody.parse(req.body);
      const outcome = await authService.verifyMagicLink({
        application: req.application!,
        token: body.token,
        device: deviceContext(req),
        // Signup policy: refuse creation via a pub key in `secret_only` apps.
        ...(req.authKind !== undefined && { authKind: req.authKind }),
      });
      if (!outcome.mfaRequired) {
        recordEndUserEvent(req, 'user.signed_in', outcome.endUser.id, { via: 'magic_link' });
      }
      return { success: true, data: shapeSignInOutcome(outcome) };
    },
  );

  // ---------- Passkey authentication (unauthenticated; pairs with /sign-in) ----------
  app.post(
    '/passkey/authenticate/start',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Begin a passkey authentication ceremony',
        description:
          'Returns `{ options, expectedChallenge }`. Forward `options` to the browser ' +
          '(`navigator.credentials.get(...)`), persist `expectedChallenge` server-side ' +
          'in the customer app session (cookie / Redis), and send both back to ' +
          '/passkey/authenticate/complete. Usernameless when `email` is omitted; ' +
          'email-first when supplied (allowCredentials scoped to that user).',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          properties: { email: { type: 'string', format: 'email', maxLength: 254 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { options: WEBAUTHN_OPTIONS, expectedChallenge: { type: 'string' } },
              required: ['options', 'expectedChallenge'],
            },
            'Forward `options` to `navigator.credentials.get(...)`; persist `expectedChallenge` and send both to /passkey/authenticate/complete.',
          ),
          ...errs({ ...BOOTSTRAP_ERRORS }),
        },
      },
    },
    async (req) => {
      const body = PasskeyAuthStartBody.parse(req.body ?? {});
      const result = await authService.passkeyAuthenticateStart({
        application: req.application!,
        ...(body.email !== undefined && { email: body.email }),
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/passkey/authenticate/complete',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Complete a passkey authentication and mint a session',
        description:
          'Verifies the browser response against `expectedChallenge` from /start. ' +
          'On success returns the same `SignInOutcome` shape as /sign-in — passkeys ' +
          'bypass MFA challenge (the passkey itself is a strong factor).',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['response', 'expectedChallenge'],
          properties: {
            response: { type: 'object' },
            expectedChallenge: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
        response: {
          200: ok(ref('SignInOutcome'), 'A finished session (passkeys bypass the MFA challenge).'),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            400: 'WEBAUTHN_AUTH_INVALID — the response is missing a credential id.',
            401:
              BOOTSTRAP_401 +
              ' Or WEBAUTHN_AUTH_INVALID — the credential is unknown to this Application, the ' +
              'challenge was stale, or the assertion did not verify.',
            403: BOOTSTRAP_403 + ' Or EMAIL_NOT_VERIFIED — the account email is unconfirmed.',
          }),
        },
      },
    },
    async (req) => {
      const body = PasskeyAuthCompleteBody.parse(req.body);
      const outcome = await authService.passkeyAuthenticateComplete({
        application: req.application!,
        expectedChallenge: body.expectedChallenge,
        response: body.response as never,
        device: deviceContext(req),
      });
      if (!outcome.mfaRequired) {
        recordEndUserEvent(req, 'user.signed_in', outcome.endUser.id, { via: 'passkey' });
      }
      return { success: true, data: shapeSignInOutcome(outcome) };
    },
  );

  app.post(
    '/verify-email',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Consume an email-verification token; marks `emailVerified: true`',
        description:
          'Single-use token, 24-hour lifetime. Refuses if the email on the token differs ' +
          'from the current account email (e.g. user changed email after the token was issued).',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { ok: { type: 'boolean', enum: [true] }, endUser: ref('EndUser') },
              required: ['ok', 'endUser'],
            },
            'The email is now verified.',
          ),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            401:
              BOOTSTRAP_401 +
              ' Or EMAIL_VERIFICATION_TOKEN_INVALID — the token is unknown; or ' +
              'EMAIL_VERIFICATION_TOKEN_USED — already consumed; or ' +
              'EMAIL_VERIFICATION_TOKEN_EXPIRED — the 24-hour window passed; or ' +
              'EMAIL_VERIFICATION_TOKEN_WRONG_APPLICATION — issued for a different Application; ' +
              'or EMAIL_VERIFICATION_STALE — the account email changed since the token was issued.',
          }),
        },
      },
    },
    async (req) => {
      const body = VerifyEmailBody.parse(req.body);
      const result = await authService.verifyEmail({
        application: req.application!,
        token: body.token,
      });
      recordEndUserEvent(req, 'user.email_verified', result.endUser.id);
      return { success: true, data: result };
    },
  );

  // The sessionless sibling of `/send-verification` (which needs one). It
  // exists because `requireEmailVerification` refuses the very session that
  // route demands, so without this a user whose mail never arrived had no
  // self-service way back. Rate-limited exactly like `/forgot-password` — same
  // surface, same cap — and enumeration-safe by construction; see
  // `authService.resendVerificationEmail`.
  app.post(
    '/resend-verification',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Re-send an email-verification link to an address (no session required)',
        description:
          'For a user blocked by `authConfig.requireEmailVerification`, who by definition ' +
          'has no session and so cannot call /auth/send-verification.\n\n' +
          'Always returns 200 with `{ emailSent: boolean, verificationToken: string|null }` ' +
          'and never discloses whether the address exists, is already verified, or was ' +
          'delivered to — a **publishable**-key caller gets one constant body whatever ' +
          'happened. A secret-key caller gets the real outcome, and the raw token when the ' +
          'Application has no email transport configured (the same contract /forgot-password ' +
          'uses).\n\n' +
          'Nothing is sent when no verification link can be built — pass `verifyUrl`, or set ' +
          'the Application URL (Panel → Application → Auth). An already-verified address is ' +
          'a no-op rather than an error.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            // No `format: uri` — see /send-verification for why.
            verifyUrl: { type: 'string', maxLength: 2048 },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              description:
                'Never discloses whether the address exists, is already verified, or was ' +
                'delivered to. A publishable caller always gets the same constant body.',
              properties: {
                emailSent: { type: 'boolean' },
                verificationToken: { type: 'string', nullable: true },
              },
              required: ['emailSent', 'verificationToken'],
            },
            'Always 200; see field semantics.',
          ),
          ...errs({ ...BOOTSTRAP_ERRORS }),
        },
      },
    },
    async (req) => {
      const body = ResendVerificationBody.parse(req.body);
      const result = await authService.resendVerificationEmail({
        application: req.application!,
        email: body.email,
        ...(body.verifyUrl !== undefined && { verifyUrl: body.verifyUrl }),
        // Gates the raw-token fallback: a publishable key must never receive it.
        ...(req.authKind !== undefined && { authKind: req.authKind }),
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/reset-password',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Consume a reset token + set a new password',
        description:
          'Single-use token; consumed atomically. On success, every refresh token for ' +
          'this end-user is revoked — anyone holding a session via the compromised credential is signed out.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['token', 'newPassword'],
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 512 },
            newPassword: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: okFlag('Password changed; every refresh token for this end-user was revoked.'),
          ...errs({
            ...BOOTSTRAP_ERRORS,
            400:
              'PASSWORD_TOO_SHORT — shorter than `authConfig.passwordMinLength`; or ' +
              'PASSWORD_BREACHED — the password appears in a known breach corpus.',
            401:
              BOOTSTRAP_401 +
              ' Or PASSWORD_RESET_TOKEN_INVALID — the token is unknown; or ' +
              'PASSWORD_RESET_TOKEN_USED — already consumed; or PASSWORD_RESET_TOKEN_EXPIRED — ' +
              'expired; or PASSWORD_RESET_TOKEN_WRONG_APPLICATION — issued for a different Application.',
          }),
        },
      },
    },
    async (req) => {
      const body = ResetPasswordBody.parse(req.body);
      const result = await authService.resetPassword({
        application: req.application!,
        token: body.token,
        newPassword: body.newPassword,
      });
      recordEndUserEvent(req, 'user.password_reset', null);
      return { success: true, data: result };
    },
  );
}

/**
 * Authenticated auth-management routes — separate plugin so the user-session
 * middleware can be added once via `addHook` without affecting the
 * public-bootstrap routes above. Registered at the SAME `/api/v1/auth` prefix;
 * Fastify encapsulation is what keeps the two hook sets apart.
 *
 * Credential: an Application **publishable or secret** key AND the end-user
 * JWT. The JWT is the authorizer — every route here acts solely on
 * `req.endUser` — so a browser-only client can reach these with `rp_pub_…`.
 *
 * Passkey ENROLLMENT (`passkey/register/{start,complete}`) is reachable on the
 * same terms, but a **publishable** caller must additionally step up — see
 * `lib/step-up.ts`. A passkey bypasses the MFA challenge at sign-in, and neither
 * a password change nor sign-out-everywhere removes one, so a stolen access
 * token alone must not be able to enroll it. The step-up is enforced at
 * `/start`; `/complete` inherits it via the single-use challenge.
 *
 * This used to be secret-key-only. That was traded for step-up deliberately:
 * refusing the whole route made enrollment unreachable from a browser-only app
 * while doing nothing about the stolen-token case on a server-side one.
 */
export async function authenticatedAuthRoutes(app: FastifyInstance): Promise<void> {
  // Accepts the publishable key, like the pre-user siblings (`passkey/
  // authenticate/*`, `verify-email`, `forgot-password`, `reset-password`).
  // `requireUserSession` is the authorizer here — every route acts solely on
  // `req.endUser`, and change-password additionally requires the current
  // password. Secret-only meant a browser could sign in with a passkey but
  // never enroll one, and consume a verification token but never request one.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:write'));
  app.addHook('onRequest', requireUserSession);

  app.post(
    '/change-password',
    {
      preHandler: refuseWhileImpersonating("change this account's password"),
      schema: {
        tags: ['Public · Auth'],
        summary: 'Change the current user\'s password',
        description:
          'Requires the current password. On success, revokes every refresh token for this user — ' +
          'other devices are signed out. The caller\'s access token stays valid until its 15-min expiry.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 256 },
            newPassword: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: okFlag('Password changed; every other refresh token for this end-user was revoked.'),
          ...errs({
            ...AUTHENTICATED_ERRORS,
            400:
              'PASSWORD_TOO_SHORT — shorter than `authConfig.passwordMinLength`; or ' +
              'PASSWORD_BREACHED — the password appears in a known breach corpus.',
            401: USER_SESSION_401 + ' Or INVALID_CREDENTIALS — the current password is wrong.',
            403: IMPERSONATION_403,
          }),
        },
      },
    },
    async (req) => {
      const body = ChangePasswordBody.parse(req.body);
      const result = await authService.changePassword({
        application: req.application!,
        endUserId: req.endUser!.id,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
      recordEndUserEvent(req, 'user.password_changed', req.endUser!.id);
      return { success: true, data: result };
    },
  );

  app.post(
    '/send-verification',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Send (or re-send) an email-verification link to the current user',
        description:
          'Mints a 24-hour single-use verification token bound to (user, application, email). ' +
          'If email transport is configured (BYO Resend or RESEND_DEFAULT_*), we send the email ' +
          'and `verificationToken` is null. Otherwise we return the raw token for the caller to ' +
          'forward via their own provider.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          // No `format: uri` here — Ajv's strict URI check rejects URLs
          // containing `{token}` placeholders. Zod handles the URL parse
          // (WHATWG, permissive) inside the handler.
          properties: { verifyUrl: { type: 'string', maxLength: 2048 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                emailSent: { type: 'boolean' },
                verificationToken: {
                  type: 'string',
                  nullable: true,
                  description: 'Non-null only when the Application has no email transport configured.',
                },
              },
              required: ['emailSent', 'verificationToken'],
            },
            'Verification link (re)sent.',
          ),
          ...errs({
            ...AUTHENTICATED_ERRORS,
            400: 'EMAIL_ALREADY_VERIFIED — no further action is needed.',
          }),
        },
      },
    },
    async (req) => {
      const body = SendVerificationBody.parse(req.body ?? {});
      const result = await authService.sendVerificationEmail({
        application: req.application!,
        endUserId: req.endUser!.id,
        ...(body.verifyUrl !== undefined && { verifyUrl: body.verifyUrl }),
      });
      return { success: true, data: result };
    },
  );

  // ---------- Passkey registration + management (authenticated) ----------
  app.post(
    '/passkey/register/start',
    {
      // Refused outright for an impersonating operator: a passkey enrolled
      // during a 5-minute support session is a permanent sign-in credential on
      // somebody else's account, and the step-up below does not stop it — an
      // operator can hold the user's password (they can set one) without ever
      // being the user.
      preHandler: refuseWhileImpersonating('enroll a passkey on this account'),
      // Reachable from a browser, but only behind a STEP-UP.
      //
      // Enrolling a passkey is a persistent-takeover primitive: a passkey is a
      // strong factor that BYPASSES the MFA challenge (see
      // `authService.passkeyAuthenticateComplete`), so an attacker who enrolled
      // one could
      // sign in later with no password and no second factor. Neither
      // change-password nor sign-out-everywhere removes it — the victim would
      // have to notice a stranger's row in GET /passkeys.
      //
      // This used to be secret-key-only for that reason, which was the safe
      // holding position but not a fix: it made passkey enrollment unreachable
      // from a browser-only app while doing nothing about a stolen token on a
      // server-side one. lib/step-up.ts is the actual control — a publishable
      // caller must re-prove identity with the account password or a current
      // authenticator code, neither of which the access token carries.
      schema: {
        tags: ['Public · Auth'],
        summary: 'Begin a passkey registration ceremony for the current user',
        description:
          'Returns `{ options, expectedChallenge }`. Forward `options` to ' +
          '`navigator.credentials.create(...)` and POST the result back to ' +
          '/passkey/register/complete along with the same `expectedChallenge`.\n\n' +
          'A **publishable**-key caller must also send a step-up proof: `password` ' +
          '(the account password) or `code` (a current authenticator or unused ' +
          'backup code). A passkey bypasses the MFA challenge at sign-in, so a ' +
          'stolen access token alone must not be able to enroll one. Secret-key ' +
          'callers are not required to step up — the customer backend is the gate.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          properties: {
            password: { type: 'string', minLength: 1, maxLength: 200 },
            code: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { options: WEBAUTHN_OPTIONS, expectedChallenge: { type: 'string' } },
              required: ['options', 'expectedChallenge'],
            },
            'Forward `options` to `navigator.credentials.create(...)`; POST the result to /passkey/register/complete along with `expectedChallenge`.',
          ),
          ...errs({
            ...AUTHENTICATED_ERRORS,
            400:
              'STEP_UP_UNAVAILABLE — a publishable caller has no password and no MFA enrolled, ' +
              'so there is no second factor to step up with.',
            401:
              USER_SESSION_401 +
              ' Or STEP_UP_REQUIRED — a publishable caller did not send a valid `password` or `code`.',
            403: IMPERSONATION_403,
          }),
        },
      },
      // `password`/`code` are optional, so a secret-key caller may POST no body.
      // Fastify validates a missing body against the schema and answers 400
      // "body must be object" — the same trap that broke mfa/disable.
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
      },
    },
    async (req) => {
      if (req.authKind === 'publishable') {
        const proof = (req.body ?? {}) as { password?: unknown; code?: unknown };
        await assertStepUp({
          endUserId: req.endUser!.id,
          action: 'enroll a passkey',
          proof: {
            ...(typeof proof.password === 'string' && { password: proof.password }),
            ...(typeof proof.code === 'string' && { code: proof.code }),
          },
          verifyMfaCode: (a) => mfaService.verify(a),
        });
      }
      const result = await authService.passkeyRegisterStart({
        application: req.application!,
        endUserId: req.endUser!.id,
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/passkey/register/complete',
    {
      preHandler: refuseWhileImpersonating('enroll a passkey on this account'),
      // Same credentials as the rest of this plugin (publishable or secret key
      // + the user's token) — no extra route-level hook.
      //
      // No step-up here, and that is not an oversight: the step-up happens at
      // /passkey/register/start, and `consumeChallenge` binds this ceremony to it.
      // The challenge is single-use and scoped to (application, endUserId), so a
      // caller cannot invent one or replay somebody else's — it must have come
      // from a start call that already proved identity. Demanding a second factor
      // again here would only ask the user to re-enter a code mid-ceremony.
      schema: {
        tags: ['Public · Auth'],
        summary: 'Complete a passkey registration; stores the credential',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          required: ['response', 'expectedChallenge'],
          properties: {
            response: { type: 'object' },
            expectedChallenge: { type: 'string', minLength: 1, maxLength: 1024 },
            deviceName: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
        response: {
          // NOT `ref('Passkey')`: `authService.passkeyRegisterComplete` returns only
          // `{credentialId, deviceName}` (auth.service.ts) — it never fetches `id`, `lastUsedAt`,
          // or `createdAt`, all of which `Passkey` requires. Modelled inline rather than forcing
          // a component that would over-promise fields this handler does not send.
          200: ok(
            {
              type: 'object',
              properties: {
                credentialId: { type: 'string' },
                deviceName: { type: 'string', nullable: true },
              },
              required: ['credentialId', 'deviceName'],
            },
            'The stored passkey.',
          ),
          ...errs({
            ...AUTHENTICATED_ERRORS,
            401: USER_SESSION_401 + ' Or WEBAUTHN_REGISTRATION_FAILED — the ceremony did not verify.',
            403: IMPERSONATION_403,
            409: 'WEBAUTHN_ALREADY_REGISTERED — this passkey is already registered.',
          }),
        },
      },
    },
    async (req) => {
      const body = PasskeyRegisterCompleteBody.parse(req.body);
      const result = await authService.passkeyRegisterComplete({
        application: req.application!,
        endUserId: req.endUser!.id,
        expectedChallenge: body.expectedChallenge,
        response: body.response as never,
        ...(body.deviceName !== undefined && { deviceName: body.deviceName }),
      });
      recordEndUserEvent(req, 'user.passkey_added', req.endUser!.id, {
        credentialId: result.credentialId,
      });
      return { success: true, data: result };
    },
  );

  app.get(
    '/passkeys',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'List the current user\'s registered passkeys',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          // `authService.listPasskeys` selects exactly `{id, credentialId, deviceName,
          // lastUsedAt, createdAt}` — matches the corrected `Passkey` component field-for-field.
          200: okPage(ref('Passkey'), "A page of the current user's registered passkeys."),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...AUTHENTICATED_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await authService.listPasskeys(req.endUser!.id, { take, skip });
      return {
        success: true,
        data: paged(
          items.map((r) => ({
            id: r.id,
            credentialId: r.credentialId,
            deviceName: r.deviceName,
            lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
            createdAt: r.createdAt.toISOString(),
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.delete(
    '/passkeys/:id',
    {
      // Removing a factor is a credential change too: an operator who strips
      // the user's passkeys leaves them signing in with less than they chose.
      preHandler: refuseWhileImpersonating("remove this account's passkeys"),
      schema: {
        tags: ['Public · Auth'],
        summary: 'Remove a passkey from the current user',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(
            {
              type: 'object',
              properties: { deleted: { type: 'boolean' } },
              required: ['deleted'],
              description: '`deleted: false` when the id did not match any of this user\'s passkeys.',
            },
            'Deletion outcome.',
          ),
          ...errs({ ...AUTHENTICATED_ERRORS, 403: IMPERSONATION_403 }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      const result = await authService.deletePasskey({
        application: req.application!,
        endUserId: req.endUser!.id,
        credentialRowId: params.id,
      });
      if (result.deleted) {
        recordEndUserEvent(req, 'user.passkey_removed', req.endUser!.id, {
          credentialRowId: params.id,
        });
      }
      return { success: true, data: result };
    },
  );

  app.get(
    '/sessions',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'List the current user\'s active sessions (live refresh tokens)',
        description:
          'Returns active sessions ordered newest-first, with the User-Agent + IP captured ' +
          'at issue time. Use the returned `id` to revoke individual sessions via DELETE /sessions/:id.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
                expiresAt: { type: 'string', format: 'date-time' },
                userAgent: { type: 'string', nullable: true },
                ip: { type: 'string', nullable: true },
              },
              required: ['id', 'createdAt', 'expiresAt', 'userAgent', 'ip'],
            },
            "A page of the current user's active sessions (live refresh tokens), newest first.",
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...AUTHENTICATED_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await authService.listSessions(req.endUser!.id, { take, skip });
      return {
        success: true,
        data: paged(
          items.map((r) => ({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            userAgent: r.userAgent,
            ip: r.ip,
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.delete(
    '/sessions/:id',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Revoke one session by id. Idempotent.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(
            {
              type: 'object',
              properties: { revoked: { type: 'boolean' } },
              required: ['revoked'],
              description: '`revoked: false` when the id did not match any active session for this user.',
            },
            'Revocation outcome.',
          ),
          ...errs({ ...AUTHENTICATED_ERRORS }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      const result = await authService.revokeSession({
        application: req.application!,
        endUserId: req.endUser!.id,
        sessionId: params.id,
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/sign-out-everywhere',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Revoke every refresh token for the current user',
        description:
          'Used for "sign out of all devices" / suspected compromise. The caller\'s ' +
          'access token stays valid until its 15-min expiry; clear it client-side for full logout.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(
            {
              type: 'object',
              properties: { revokedCount: { type: 'integer' } },
              required: ['revokedCount'],
            },
            'Every refresh token for this end-user was revoked.',
          ),
          ...errs({ ...AUTHENTICATED_ERRORS }),
        },
      },
    },
    async (req) => {
      const result = await authService.signOutEverywhere(req.endUser!.id);
      recordEndUserEvent(req, 'user.sessions_revoked', req.endUser!.id, {
        revokedCount: result.revokedCount,
      });
      return { success: true, data: result };
    },
  );
}
