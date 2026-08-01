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
import { mfaService } from '../mfa/mfa.service.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';

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
  type: string,
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
      },
    },
    async (req) => {
      const rows = await authService.listPasskeys(req.endUser!.id);
      return {
        success: true,
        data: rows.map((r) => ({
          id: r.id,
          credentialId: r.credentialId,
          deviceName: r.deviceName,
          lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );

  app.delete(
    '/passkeys/:id',
    {
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
      },
    },
    async (req) => {
      const rows = await authService.listSessions(req.endUser!.id);
      return {
        success: true,
        data: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          userAgent: r.userAgent,
          ip: r.ip,
        })),
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
