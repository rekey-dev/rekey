import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  tenantAuthService,
  type AuthSessionResult,
  type TenantSignInOutcome,
} from './tenant-auth.service.js';
import { requireTenantSession, requireTenantRole } from '../../middleware/tenant-session.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { listApiRequests } from '../../lib/request-log.js';
import {
  PaginationQuery,
  parsePagination,
  paged,
  paginationJsonSchema,
} from '../../lib/pagination.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { operatorTokensService } from './operator-tokens.service.js';
import { OPERATOR_TOKEN_SCOPES } from '../../lib/operator-token.js';
import { operatorSignupMode } from './operator-signup-policy.js';
import { ok, okPage, okFlag, errs, ref } from '../../lib/openapi.js';

function deviceContext(req: FastifyRequest): { userAgent: string | null; ip: string | null } {
  const ua = req.headers['user-agent'];
  return {
    userAgent: typeof ua === 'string' && ua.length > 0 ? ua : null,
    ip: req.ip || null,
  };
}

const SignUpBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  name: z.string().min(1).max(120).optional(),
  workspaceName: z.string().min(1).max(120),
  // Single-use invite key — required only when OPERATOR_SIGNUP_MODE='invite'.
  inviteKey: z.string().min(1).max(512).optional(),
});

const SignInBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const RefreshBody = z.object({ refreshToken: z.string().min(1).max(512) });
const SignOutBody = z.object({ refreshToken: z.string().min(1).max(512) });
const SwitchBody = z.object({ tenantId: z.string().min(1) });
const ForgotBody = z.object({ email: z.string().email().max(254) });
const MagicLinkRequestBody = z.object({ email: z.string().email().max(254) });
const MagicLinkVerifyBody = z.object({ token: z.string().min(1).max(512) });
const ResetBody = z.object({
  token: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(256),
});
const ChangeBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

function shape(result: AuthSessionResult): Record<string, unknown> {
  return {
    mfaRequired: false,
    user: result.user,
    memberships: result.memberships,
    activeTenantId: result.activeTenantId,
    activeRole: result.activeRole,
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
  };
}

function shapeSignInOutcome(outcome: TenantSignInOutcome): Record<string, unknown> {
  if (outcome.mfaRequired) {
    return {
      mfaRequired: true,
      user: outcome.user,
      mfaChallengeToken: outcome.mfaChallengeToken,
      mfaChallengeExpiresAt: outcome.mfaChallengeExpiresAt.toISOString(),
    };
  }
  return shape(outcome);
}

const MfaVerifyBody = z.object({
  mfaChallengeToken: z.string().min(1).max(2048),
  code: z.string().min(1).max(64),
});

const MintApiTokenBody = z.object({
  name: z.string().min(1).max(120),
  // Default-deny: empty/absent ⇒ ['read'] (applied in the service). Unknown
  // scopes are rejected there too.
  scopes: z.array(z.enum(OPERATOR_TOKEN_SCOPES)).default([]),
  expiresAt: z.string().datetime().optional(),
});

function shapeOperatorToken(
  token: import('./operator-tokens.service.js').PublicOperatorToken,
): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    tenantId: token.tenantId,
    expiresAt: token.expiresAt ? token.expiresAt.toISOString() : null,
    lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    revokedAt: token.revokedAt ? token.revokedAt.toISOString() : null,
    createdAt: token.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// OpenAPI response fragments
// ---------------------------------------------------------------------------

/**
 * `AuthSessionResult` (see `shape()` above) — a full operator session. `OperatorSession` (the
 * corrected component) already requires `user` / `memberships` (as `MembershipSummary[]`) /
 * `activeTenantId` / `activeRole` alongside the token pair, so this only needs to `allOf` in the
 * one field it adds on top: `shape()` stamps `mfaRequired: false` that isn't part of
 * `AuthSessionResult` itself.
 */
const TenantSession = {
  description: 'An operator session — token pair, memberships, and the active workspace.',
  allOf: [
    ref('OperatorSession'),
    {
      type: 'object',
      properties: {
        mfaRequired: { type: 'boolean', enum: [false], description: 'Always `false` here.' },
      },
      required: ['mfaRequired'],
    },
  ],
};

/** `TenantMfaChallengeResult` — the primary factor passed; a second is required. */
const TenantMfaChallenge = {
  type: 'object',
  description: 'The primary factor passed but MFA is enrolled. Resolve via POST /mfa-verify.',
  properties: {
    mfaRequired: { type: 'boolean', enum: [true] },
    user: ref('Operator'),
    mfaChallengeToken: {
      type: 'string',
      description: 'Single-use, expires after 5 minutes. POST to /mfa-verify.',
    },
    mfaChallengeExpiresAt: { type: 'string', format: 'date-time' },
  },
  required: ['mfaRequired', 'user', 'mfaChallengeToken', 'mfaChallengeExpiresAt'],
};

/** `TenantSignInOutcome` — discriminated union on `mfaRequired`. */
const TenantSignInOutcome = {
  description:
    'Either a full session (`mfaRequired: false`) or an MFA challenge ' +
    '(`mfaRequired: true`) to resolve via POST /mfa-verify.',
  oneOf: [TenantSession, TenantMfaChallenge],
};

/** One row of GET /sessions. Dates are pre-serialised to ISO strings by the handler. */
const SessionItem = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    userAgent: { type: 'string', nullable: true },
    ip: { type: 'string', nullable: true },
  },
  required: ['id', 'createdAt', 'expiresAt'],
};

/**
 * The 401/403 pair `requireTenantSession` (middleware/tenant-session.ts) produces, shared by
 * every route in `tenantAuthAuthenticatedRoutes` below.
 */
const TENANT_SESSION_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or TENANT_SESSION_INVALID — ' +
    'the session JWT is malformed, expired, or its operator no longer exists.',
  403: "TENANT_MEMBERSHIP_REVOKED — the session's workspace no longer has a live membership for this operator.",
} as const;

/**
 * Unauthenticated tenant-auth endpoints. Mounted under /api/v1/tenant/auth —
 * the SAME prefix as `tenantAuthAuthenticatedRoutes` below, but no hook is
 * registered here, and Fastify encapsulation keeps `requireTenantSession` off
 * these routes. Every one is annotated `security: []`.
 *
 * "No security scheme" is not the same as "no credential": `/mfa-verify`,
 * `/refresh`, `/sign-out`, `/reset-password` and `/magic-link/verify` all carry
 * a single-use token **in the request body**. That is not an
 * `Authorization`-header credential, so it cannot be an OpenAPI security scheme
 * — it is documented as a body field instead.
 */
export async function tenantAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/signup-mode',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Operator-registration mode for this deployment (open | invite | closed)',
        description:
          'Public UX hint so the sign-up page can render the right state: an invite-key ' +
          'field (invite), a "registration closed" notice (closed), or the plain form (open). ' +
          'Not a secret — enforcement happens server-side at every creation path regardless.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { mode: { type: 'string', enum: ['open', 'invite', 'closed'] } },
              required: ['mode'],
            },
            'The deployment\'s operator-registration mode.',
          ),
          ...errs({ 429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.' }),
        },
      },
    },
    async () => ({ success: true, data: { mode: operatorSignupMode() } }),
  );

  app.post(
    '/sign-up',
    {
      // Unauthenticated, and it creates an operator account AND a Tenant AND
      // an OWNER membership per call, which is the most expensive thing an
      // anonymous caller can ask this API to do. Every sibling on this router
      // carries a ceiling; this one did not. Same budget as sign-in: the
      // bucket keys on the submitted identity plus the IP, so a real person
      // signing up once is nowhere near it.
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Self-serve sign-up — creates an operator account, a Tenant, and an OWNER membership',
        description:
          'Gated by OPERATOR_SIGNUP_MODE: open (anyone), invite (requires a single-use `inviteKey`), ' +
          'or closed (rejected). Mode is advertised at GET /signup-mode.',
        body: {
          type: 'object',
          required: ['email', 'password', 'workspaceName'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            password: { type: 'string', minLength: 8, maxLength: 256 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            workspaceName: { type: 'string', minLength: 1, maxLength: 120 },
            inviteKey: {
              type: 'string',
              minLength: 1,
              maxLength: 512,
              description: 'Single-use invite key. Required when the deployment is in invite mode.',
            },
          },
        },
        response: {
          201: ok(TenantSession, 'The newly created operator session.'),
          ...errs({
            400:
              'PASSWORD_TOO_SHORT — password shorter than 8 characters; or PASSWORD_BREACHED — ' +
              'found in a known breach corpus (unless HIBP_BREACH_CHECK_DISABLED).',
            403:
              'OPERATOR_SIGNUP_CLOSED — sign-up is disabled on this deployment; or ' +
              'OPERATOR_INVITE_REQUIRED — invite mode requires `inviteKey`; or ' +
              'OPERATOR_INVITE_INVALID — the invite key does not match a pending invite; or ' +
              'OPERATOR_INVITE_EXPIRED — the invite has expired.',
            409:
              'EMAIL_ALREADY_EXISTS — an operator with that email already exists; or ' +
              'OPERATOR_INVITE_USED — the invite was already consumed (race lost).',
          }),
        },
      },
    },
    async (req, reply) => {
      const body = SignUpBody.parse(req.body);
      const result = await tenantAuthService.signUpAndCreateWorkspace({
        ...body,
        device: deviceContext(req),
      });
      return reply.status(201).send({ success: true, data: shape(result) });
    },
  );

  app.post(
    '/sign-in',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Operator sign-in. Returns memberships + a session scoped to the first workspace.',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: ok(TenantSignInOutcome, 'A session, or an MFA challenge to resolve via /mfa-verify.'),
          ...errs({
            401: 'INVALID_CREDENTIALS — email/password did not match.',
            403: 'NO_TENANT_MEMBERSHIPS — the operator has no workspace memberships.',
            429:
              'TOO_MANY_FAILED_ATTEMPTS — brute-force lockout after repeated bad credentials; ' +
              'or RATE_LIMITED — too many requests to this endpoint. Honour `Retry-After`.',
            503: 'DEPENDENCY_UNAVAILABLE — the lockout store (Redis) is unreachable.',
          }),
        },
      },
    },
    async (req) => {
      const body = SignInBody.parse(req.body);
      const outcome = await tenantAuthService.signIn({
        ...body,
        device: deviceContext(req),
      });
      // Audit successful operator sign-ins (full sessions only; MFA-required
      // outcomes are logged when /mfa-verify completes). Best-effort.
      const sess = outcome as {
        accessToken?: string;
        user?: { id: string };
        activeTenantId?: string;
      };
      if (sess.accessToken && sess.user) {
        void recordSecurityEvent({
          type: 'operator.sign_in',
          actorType: 'operator',
          actorId: sess.user.id,
          tenantId: sess.activeTenantId ?? null,
          ...deviceContext(req),
        });
      }
      return { success: true, data: shapeSignInOutcome(outcome) };
    },
  );

  app.post(
    '/mfa-verify',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Exchange an operator MFA challenge token + code for a real session',
        description:
          'Called after /sign-in returns `mfaRequired: true`. The challenge token expires after 5 minutes and is bound to the operator that just passed the primary factor.',
        body: {
          type: 'object',
          required: ['mfaChallengeToken', 'code'],
          properties: {
            mfaChallengeToken: { type: 'string', minLength: 1, maxLength: 2048 },
            code: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: {
          200: ok(TenantSession, 'The resolved operator session.'),
          ...errs({
            401:
              'MFA_CHALLENGE_INVALID — the challenge token is unknown, expired, or malformed; ' +
              'or MFA_CODE_INVALID — the TOTP/backup code did not verify.',
            403: 'NO_TENANT_MEMBERSHIPS — the operator has no workspace memberships.',
            429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.',
          }),
        },
      },
    },
    async (req) => {
      const body = MfaVerifyBody.parse(req.body);
      const result = await tenantAuthService.verifyMfaChallenge({
        ...body,
        device: deviceContext(req),
      });
      return { success: true, data: shape(result) };
    },
  );

  app.post(
    '/refresh',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Exchange a refresh token for a new pair (rotated)',
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(TenantSession, 'A newly rotated session.'),
          ...errs({
            401:
              'REFRESH_TOKEN_INVALID — the token is unknown; or REFRESH_TOKEN_REUSED — a ' +
              'rotated token was replayed (every session for the operator is revoked); or ' +
              'REFRESH_TOKEN_REVOKED — it was already revoked; or REFRESH_TOKEN_EXPIRED.',
            403: 'NO_TENANT_MEMBERSHIPS — the operator has no workspace memberships.',
          }),
        },
      },
    },
    async (req) => {
      const body = RefreshBody.parse(req.body);
      const result = await tenantAuthService.refresh(body.refreshToken);
      return { success: true, data: shape(result) };
    },
  );

  app.post(
    '/sign-out',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Revoke the presented refresh token (idempotent)',
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { signedOut: { type: 'boolean', enum: [true] } },
              required: ['signedOut'],
            },
            'Always succeeds — revocation is idempotent, so an unknown/expired token still ' +
              'reports `signedOut: true`.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `refreshToken` is missing or outside 1-512 chars.',
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
        },
      },
    },
    async (req) => {
      const body = SignOutBody.parse(req.body);
      await tenantAuthService.signOut(body.refreshToken);
      return { success: true, data: { signedOut: true } };
    },
  );

  app.post(
    '/forgot-password',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Request a password reset. Emailed to the operator; the raw token is returned only in dev or with no email transport.',
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              description:
                'Enumeration-safe: this shape is returned whether or not the email exists.',
              properties: {
                delivered: { type: 'boolean', enum: [true] },
                resetToken: {
                  type: 'string',
                  nullable: true,
                  description:
                    'The raw reset token. Present only when no email transport is configured ' +
                    '(dev convenience) — otherwise `null` and the token is emailed instead.',
                },
              },
              required: ['delivered', 'resetToken'],
            },
            'Always reports delivered, regardless of whether the email exists.',
          ),
          ...errs({ 429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.' }),
        },
      },
    },
    async (req) => {
      const body = ForgotBody.parse(req.body);
      const result = await tenantAuthService.requestPasswordReset(body);
      return { success: true, data: result };
    },
  );

  app.post(
    '/reset-password',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Consume a reset token + set new password (revokes all sessions)',
        body: {
          type: 'object',
          required: ['token', 'newPassword'],
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 512 },
            newPassword: { type: 'string', minLength: 8, maxLength: 256 },
          },
        },
        response: {
          200: okFlag('Password changed; every session for the operator is revoked.'),
          ...errs({
            400:
              'PASSWORD_TOO_SHORT — password shorter than 8 characters; or PASSWORD_BREACHED — ' +
              'found in a known breach corpus (unless HIBP_BREACH_CHECK_DISABLED).',
            401:
              'PASSWORD_RESET_TOKEN_INVALID — unknown token; or PASSWORD_RESET_TOKEN_USED — ' +
              'already consumed; or PASSWORD_RESET_TOKEN_EXPIRED.',
            429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.',
          }),
        },
      },
    },
    async (req) => {
      const body = ResetBody.parse(req.body);
      const result = await tenantAuthService.resetPassword(body);
      return { success: true, data: result };
    },
  );

  app.post(
    '/magic-link/request',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Request a passwordless sign-in link. Emailed to the operator; the raw token is returned only in dev or with no email transport.',
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              description:
                'Enumeration-safe: this shape is returned whether or not the email exists.',
              properties: {
                delivered: { type: 'boolean', enum: [true] },
                token: {
                  type: 'string',
                  nullable: true,
                  description:
                    'The raw magic-link token. Present only when no email transport is ' +
                    'configured (dev convenience) — otherwise `null` and the token is emailed.',
                },
              },
              required: ['delivered', 'token'],
            },
            'Always reports delivered, regardless of whether the email exists.',
          ),
          ...errs({ 429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.' }),
        },
      },
    },
    async (req) => {
      const body = MagicLinkRequestBody.parse(req.body);
      // Enumeration-safe: the response shape never reveals whether the email exists.
      const result = await tenantAuthService.requestMagicLink(body);
      return { success: true, data: result };
    },
  );

  app.post(
    '/magic-link/verify',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: {
        tags: ['Tenant · Auth'],
        security: [],
        summary: 'Consume a magic-link token + mint an operator session (or MFA challenge)',
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(TenantSignInOutcome, 'A session, or an MFA challenge to resolve via /mfa-verify.'),
          ...errs({
            401:
              'MAGIC_LINK_TOKEN_INVALID — unknown token; or MAGIC_LINK_TOKEN_USED — already ' +
              'consumed; or MAGIC_LINK_TOKEN_EXPIRED.',
            403: 'NO_TENANT_MEMBERSHIPS — the operator has no workspace memberships.',
            429: 'RATE_LIMITED — too many requests. Honour `Retry-After`.',
          }),
        },
      },
    },
    async (req) => {
      const body = MagicLinkVerifyBody.parse(req.body);
      const result = await tenantAuthService.verifyMagicLink({ token: body.token, device: deviceContext(req) });
      return { success: true, data: result };
    },
  );
}

/**
 * Authenticated tenant-auth endpoints. Mounted under /api/v1/tenant/auth
 * (separate plugin so the session middleware applies here only).
 */
export async function tenantAuthAuthenticatedRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/me',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Current operator + memberships + active workspace',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                user: ref('Operator'),
                memberships: { type: 'array', items: ref('MembershipSummary') },
                activeTenantId: { type: 'string' },
                activeRole: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
              },
              required: ['user', 'memberships', 'activeTenantId', 'activeRole'],
            },
            'The calling operator.',
          ),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            404: 'TENANT_USER_NOT_FOUND — the operator behind this session no longer exists.',
          }),
        },
      },
    },
    async (req) => {
      const { user, memberships } = await tenantAuthService.getById(req.tenantUser!.id);
      return {
        success: true,
        data: {
          user,
          memberships,
          activeTenantId: req.tenantId,
          activeRole: req.tenantRole,
        },
      };
    },
  );

  app.post(
    '/switch-workspace',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Switch the active workspace. Returns a new {access, refresh} pair scoped to the target.',
        body: {
          type: 'object',
          required: ['tenantId'],
          properties: { tenantId: { type: 'string', minLength: 1 } },
        },
        response: {
          200: ok(TenantSession, 'A new session pair scoped to the target workspace.'),
          ...errs({
            401: TENANT_SESSION_ERRORS[401],
            403:
              "TENANT_MEMBERSHIP_REVOKED — the session's current workspace no longer has a " +
              'live membership; or NOT_A_MEMBER — the operator has no membership in the ' +
              'requested `tenantId`.',
          }),
        },
      },
    },
    async (req) => {
      const body = SwitchBody.parse(req.body);
      const result = await tenantAuthService.switchWorkspace({
        tenantUserId: req.tenantUser!.id,
        targetTenantId: body.tenantId,
        device: deviceContext(req),
      });
      return { success: true, data: shape(result) };
    },
  );

  app.get(
    '/sessions',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'List the operator\'s active sessions',
        description:
          'Returns active sessions (live refresh tokens) ordered newest-first, with the ' +
          'User-Agent + IP captured at issue time. Use the returned `id` to revoke individual ' +
          'sessions via DELETE /sessions/:id.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(SessionItem, "A page of the operator's active sessions, newest first."),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...TENANT_SESSION_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await tenantAuthService.listSessions(req.tenantUser!.id, {
        take,
        skip,
      });
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
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke one operator session by id. Idempotent.',
        description:
          'Revokes exactly the named session and nothing else. The revoked device keeps its ' +
          'short-lived access token until it expires (15 minutes); its next refresh answers ' +
          '401 `REFRESH_TOKEN_REVOKED` and it does not affect any other session. Replaying a ' +
          'token that was ROTATED rather than revoked is still treated as chain compromise and ' +
          'revokes every session — see POST /refresh.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { revoked: { type: 'boolean' } },
              required: ['revoked'],
            },
            'Whether a live session matching that id was found and revoked (`false` if it was ' +
              'already gone — this endpoint is idempotent).',
          ),
          ...errs(TENANT_SESSION_ERRORS),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      const result = await tenantAuthService.revokeSession({
        tenantUserId: req.tenantUser!.id,
        sessionId: params.id,
      });
      void recordSecurityEvent({
        type: 'operator.session_revoked',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId ?? null,
        ...deviceContext(req),
        metadata: { sessionId: params.id },
      });
      return { success: true, data: result };
    },
  );

  app.get(
    '/requests',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Recent API requests made by the calling operator',
        description:
          "The operator's own requests to the tenant API (the panel calls these on " +
          'their behalf), newest first. Best-effort log capped per operator by a ' +
          'periodic pruner — a convenience tail, not a billing-grade audit trail. ' +
          'Paginated via ?limit&offset.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          // `page.total` is what the pruner has left for this operator, not
          // every request they have ever made — the description says so. It is
          // still the honest answer to "is there another page", which the old
          // `{requests: [...]}` wrapper could not give at all.
          200: okPage(
            ref('ApiRequestLog'),
            "A page of the operator's own recent API requests, newest first.",
          ),
          ...errs(TENANT_SESSION_ERRORS),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await listApiRequests({
        operatorUserId: req.tenantUser!.id,
        take,
        skip,
      });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/sign-out-everywhere',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke every refresh token for the calling operator (logout all devices)',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { revokedCount: { type: 'integer' } },
              required: ['revokedCount'],
            },
            'Count of live sessions revoked.',
          ),
          ...errs(TENANT_SESSION_ERRORS),
        },
      },
    },
    async (req) => {
      const result = await tenantAuthService.signOutEverywhere(req.tenantUser!.id);
      void recordSecurityEvent({
        type: 'operator.sign_out_everywhere',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId ?? null,
        ...deviceContext(req),
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/change-password',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Authenticated password change. Revokes other sessions on success.',
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 256 },
            newPassword: { type: 'string', minLength: 8, maxLength: 256 },
          },
        },
        response: {
          200: okFlag('Password changed; other sessions for the operator are revoked.'),
          ...errs({
            400:
              'PASSWORD_TOO_SHORT — password shorter than 8 characters; or PASSWORD_BREACHED — ' +
              'found in a known breach corpus (unless HIBP_BREACH_CHECK_DISABLED).',
            401: TENANT_SESSION_ERRORS[401] + '; or INVALID_CREDENTIALS — currentPassword did not match.',
            403: TENANT_SESSION_ERRORS[403],
          }),
        },
      },
    },
    async (req) => {
      const body = ChangeBody.parse(req.body);
      const result = await tenantAuthService.changePassword({
        tenantUserId: req.tenantUser!.id,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
      return { success: true, data: result };
    },
  );

  // ---- Operator personal-access-tokens (PATs) ----
  //
  // Long-lived, revocable, scoped `rp_op_…` tokens. An operator manages their
  // OWN tokens only (every op is scoped to req.tenantUser.id) and the token is
  // bound to the active workspace (req.tenantId). The raw token is shown ONCE.

  app.post(
    '/api-tokens',
    {
      // Minting a PAT is at least as privileged as the writes it can perform
      // (a PAT may carry 'keys:mint'), so gate it like API-key minting.
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Mint a personal-access-token (raw shown once)',
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\n' +
          'Mints a long-lived, revocable, scoped operator PAT bound to the active workspace. ' +
          'Default-deny: omit `scopes` for read-only. Allowed scopes: read, applications:write, keys:mint. ' +
          'The `rawToken` is shown exactly once and cannot be recovered.',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            scopes: {
              type: 'array',
              items: { type: 'string', enum: [...OPERATOR_TOKEN_SCOPES] },
            },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                apiToken: ref('OperatorToken'),
                rawToken: { type: 'string', description: 'The raw `rp_op_…` secret. Shown once.' },
                warning: { type: 'string' },
              },
              required: ['apiToken', 'rawToken', 'warning'],
            },
            'The minted personal-access-token. `rawToken` is shown exactly once.',
          ),
          ...errs({
            400:
              'OPERATOR_SCOPE_UNKNOWN — an unrecognised scope was requested; or ' +
              'OPERATOR_TOKEN_EXPIRY_IN_PAST — `expiresAt` is not in the future; or ' +
              'OPERATOR_TOKEN_LIMIT_REACHED — the operator already has 25 active tokens.',
            401: TENANT_SESSION_ERRORS[401],
            403:
              "TENANT_MEMBERSHIP_REVOKED — the session's workspace no longer has a live " +
              'membership; or TENANT_ROLE_INSUFFICIENT — the caller is not OWNER or ADMIN in ' +
              'this workspace.',
          }),
        },
      },
    },
    async (req, reply) => {
      const body = MintApiTokenBody.parse(req.body);
      const result = await operatorTokensService.mint({
        tenantUserId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        name: body.name,
        scopes: body.scopes,
        ...(body.expiresAt !== undefined && { expiresAt: new Date(body.expiresAt) }),
      });
      void recordSecurityEvent({
        type: 'operator.api_token.created',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId ?? null,
        ...deviceContext(req),
        metadata: { tokenId: result.token.id, name: body.name, scopes: result.token.scopes },
      });
      return reply.status(201).send({
        success: true,
        data: {
          apiToken: shapeOperatorToken(result.token),
          rawToken: result.rawToken,
          warning:
            'Store this rawToken now — it is shown exactly once and cannot be recovered. Treat it like a database password.',
        },
      });
    },
  );

  app.get(
    '/api-tokens',
    {
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: "List the operator's active personal-access-tokens (redacted — no hash)",
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('OperatorToken'), "A page of the operator's personal-access-tokens."),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...TENANT_SESSION_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await operatorTokensService.list(req.tenantUser!.id, { take, skip });
      return { success: true, data: paged(items.map(shapeOperatorToken), total, take, skip) };
    },
  );

  app.delete(
    '/api-tokens/:id',
    {
      // Deliberately NOT role-gated (unlike the mint above). `revoke` is scoped
      // to `req.tenantUser.id`, so this can only ever kill the caller's own
      // token — the same scoping `GET /api-tokens` relies on, which is also
      // ungated. Requiring OWNER/ADMIN here stranded an operator downgraded to
      // MEMBER with a live PAT they could see but not revoke; revocation must
      // never need more privilege than minting did.
      schema: {
        tags: ['Tenant · Auth'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke one of the operator\'s personal-access-tokens. Idempotent.',
        description:
          'No workspace role required — revocation is scoped to the calling operator, so this ' +
          'can only ever kill your own token. Deliberately looser than minting: an operator ' +
          'downgraded to MEMBER must still be able to revoke a PAT they already hold.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: {
          200: ok(ref('OperatorToken'), 'The revoked token (already-revoked is a no-op success).'),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            404: 'OPERATOR_TOKEN_NOT_FOUND — no token with that id owned by the calling operator.',
          }),
        },
      },
    },
    async (req) => {
      const params = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      const token = await operatorTokensService.revoke(req.tenantUser!.id, params.id);
      void recordSecurityEvent({
        type: 'operator.api_token.revoked',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId ?? null,
        ...deviceContext(req),
        metadata: { tokenId: params.id },
      });
      return { success: true, data: shapeOperatorToken(token) };
    },
  );
}
