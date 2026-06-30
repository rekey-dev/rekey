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
  paginationJsonSchema,
} from '../../lib/pagination.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { operatorTokensService } from './operator-tokens.service.js';
import { OPERATOR_TOKEN_SCOPES } from '../../lib/operator-token.js';
import { operatorSignupMode } from './operator-signup-policy.js';

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

/**
 * Unauthenticated tenant-auth endpoints. Mounted under /api/v1/tenant/auth.
 */
export async function tenantAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/signup-mode',
    {
      schema: {
        tags: ['Tenant · Auth'],
        summary: 'Operator-registration mode for this deployment (open | invite | closed)',
        description:
          'Public UX hint so the sign-up page can render the right state: an invite-key ' +
          'field (invite), a "registration closed" notice (closed), or the plain form (open). ' +
          'Not a secret — enforcement happens server-side at every creation path regardless.',
      },
    },
    async () => ({ success: true, data: { mode: operatorSignupMode() } }),
  );

  app.post(
    '/sign-up',
    {
      schema: {
        tags: ['Tenant · Auth'],
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
        summary: 'Operator sign-in. Returns memberships + a session scoped to the first workspace.',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
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
        summary: 'Exchange a refresh token for a new pair (rotated)',
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
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
        summary: 'Revoke the presented refresh token (idempotent)',
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
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
        summary: 'Request a password-reset token. ReliPay does not send email — caller forwards the token.',
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
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
        summary: 'Consume a reset token + set new password (revokes all sessions)',
        body: {
          type: 'object',
          required: ['token', 'newPassword'],
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 512 },
            newPassword: { type: 'string', minLength: 8, maxLength: 256 },
          },
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
        summary: 'Request a passwordless sign-in token. ReliPay does not send email — caller forwards the token.',
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
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
        summary: 'Consume a magic-link token + mint an operator session (or MFA challenge)',
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
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
        summary: 'Current operator + memberships + active workspace',
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
        summary: 'Switch the active workspace. Returns a new {access, refresh} pair scoped to the target.',
        body: {
          type: 'object',
          required: ['tenantId'],
          properties: { tenantId: { type: 'string', minLength: 1 } },
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
        summary: 'List the operator\'s active sessions',
        description:
          'Returns active sessions (live refresh tokens) ordered newest-first, with the ' +
          'User-Agent + IP captured at issue time. Use the returned `id` to revoke individual ' +
          'sessions via DELETE /sessions/:id.',
      },
    },
    async (req) => {
      const rows = await tenantAuthService.listSessions(req.tenantUser!.id);
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
        tags: ['Tenant · Auth'],
        summary: 'Revoke one operator session by id. Idempotent.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
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
        summary: 'Recent API requests made by the calling operator',
        description:
          "The operator's own requests to the tenant API (the panel calls these on " +
          'their behalf), newest first. Best-effort log capped per operator by a ' +
          'periodic pruner — a convenience tail, not a billing-grade audit trail. ' +
          'Paginated via ?limit&offset.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const requests = await listApiRequests({
        operatorUserId: req.tenantUser!.id,
        take,
        skip,
      });
      return { success: true, data: { requests } };
    },
  );

  app.post(
    '/sign-out-everywhere',
    {
      schema: {
        tags: ['Tenant · Auth'],
        summary: 'Revoke every refresh token for the calling operator (logout all devices)',
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
        summary: 'Authenticated password change. Revokes other sessions on success.',
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 256 },
            newPassword: { type: 'string', minLength: 8, maxLength: 256 },
          },
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
        summary: 'Mint a personal-access-token (raw shown once)',
        description:
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
        summary: "List the operator's active personal-access-tokens (redacted — no hash)",
      },
    },
    async (req) => {
      const tokens = await operatorTokensService.list(req.tenantUser!.id);
      return { success: true, data: tokens.map(shapeOperatorToken) };
    },
  );

  app.delete(
    '/api-tokens/:id',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Auth'],
        summary: 'Revoke one of the operator\'s personal-access-tokens. Idempotent.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
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
