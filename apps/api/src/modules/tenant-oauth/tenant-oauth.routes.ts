/**
 * Operator OAuth routes — social login for the PANEL. Public (the OAuth flow
 * IS the authentication), mounted under /api/v1/tenant/auth.
 *
 *   GET  /api/v1/tenant/auth/oauth/providers            configured provider names
 *   POST /api/v1/tenant/auth/oauth/:provider/start      → { authorizationUrl }
 *   POST /api/v1/tenant/auth/oauth/:provider/callback   → TenantSignInOutcome
 *
 * The panel owns CSRF: it sets a one-shot httpOnly `state` cookie on start and
 * verifies it on the callback. This layer only round-trips `state`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantOAuthService } from './tenant-oauth.service.js';
import type { TenantDeviceContext } from '../tenant-auth/tenant-auth.service.js';
import { ok, errs, ref } from '../../lib/openapi.js';
import { authRateLimit } from '../../lib/rate-limit.js';

/**
 * `TenantSignInOutcome` — the primary factor (the OAuth code exchange) passed; if the operator
 * has MFA enrolled this is an `MfaChallenge` instead of a full session.
 */
const TenantSession = {
  description: 'An operator session — token pair, memberships, and the active workspace.',
  allOf: [
    ref('OperatorSession'),
    {
      type: 'object',
      properties: {
        mfaRequired: { type: 'boolean', enum: [false] },
        memberships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tenantId: { type: 'string' },
              tenantName: { type: 'string' },
              role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
            },
            required: ['tenantId', 'tenantName', 'role'],
          },
        },
        activeTenantId: { type: 'string' },
        activeRole: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
      },
      required: ['mfaRequired', 'memberships', 'activeTenantId', 'activeRole'],
    },
  ],
};

const TenantMfaChallenge = {
  type: 'object',
  description: 'The OAuth login passed but MFA is enrolled. Resolve via POST /auth/mfa-verify.',
  properties: {
    mfaRequired: { type: 'boolean', enum: [true] },
    user: ref('Operator'),
    mfaChallengeToken: { type: 'string' },
    mfaChallengeExpiresAt: { type: 'string', format: 'date-time' },
  },
  required: ['mfaRequired', 'user', 'mfaChallengeToken', 'mfaChallengeExpiresAt'],
};

const TenantSignInOutcome = {
  description:
    'Either a full session (`mfaRequired: false`) or an MFA challenge ' +
    '(`mfaRequired: true`) to resolve via POST /auth/mfa-verify.',
  oneOf: [TenantSession, TenantMfaChallenge],
};

/**
 * Shared across /start and /callback — both resolve provider config via `configFor`.
 */
const OAUTH_CONFIG_ERRORS = {
  404: 'OAUTH_PROVIDER_UNKNOWN — no such provider is registered.',
  400: 'OAUTH_PROVIDER_NOT_CONFIGURED — the provider is registered but missing client id/secret env vars.',
  503: 'OAUTH_NOT_CONFIGURED — no panel base URL is configured to build the redirect URI.',
} as const;

const ProviderParam = z.object({ provider: z.string().min(1).max(40) });
const StartBody = z.object({ state: z.string().min(1).max(512) });
const CallbackBody = z.object({
  code: z.string().min(1).max(4096),
  // The state this flow started with. The panel has already checked it against
  // its own one-shot cookie; here it is the key the PKCE verifier was stored
  // under. Optional so a caller that never started a PKCE flow still works.
  state: z.string().min(1).max(512).optional(),
  // Single-use invite key — only consulted when this OAuth login would create
  // a NEW operator under OPERATOR_SIGNUP_MODE='invite'.
  inviteKey: z.string().min(1).max(512).optional(),
});

const AssertBody = z.object({ idToken: z.string().min(1).max(8192) });

function deviceContext(req: { headers: Record<string, unknown>; ip: string }): TenantDeviceContext {
  const ua = req.headers['user-agent'];
  return {
    userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null,
    ip: req.ip,
  };
}

export async function tenantOAuthPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/oauth/providers',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [],
        summary: 'List operator OAuth providers configured on this deployment',
        response: {
          200: ok(
            {
              type: 'object',
              description: 'A fixed, deployment-configured list — bounded by construction.',
              properties: {
                providers: { type: 'array', items: { type: 'string', enum: ['google', 'github'] } },
              },
              required: ['providers'],
            },
            'OAuth providers enabled on this deployment via env vars.',
          ),
          ...errs({ 429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.' }),
        },
      },
    },
    async () => ({ success: true, data: { providers: tenantOAuthService.configuredProviders() } }),
  );

  app.post(
    '/oauth/:provider/start',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [],
        summary: 'Begin operator OAuth sign-in — returns the provider authorization URL',
        params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['state'],
          properties: { state: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { authorizationUrl: { type: 'string', format: 'uri' } },
              required: ['authorizationUrl'],
            },
            "The provider's authorization URL — redirect the browser here.",
          ),
          ...errs(OAUTH_CONFIG_ERRORS),
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const { state } = StartBody.parse(req.body);
      return { success: true, data: await tenantOAuthService.buildAuthUrl({ provider, state }) };
    },
  );

  app.post(
    '/oauth/:provider/callback',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [],
        summary: 'Complete operator OAuth sign-in; mints a session (or an MFA challenge)',
        params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 4096 },
            inviteKey: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
        response: {
          200: ok(TenantSignInOutcome, 'A session, or an MFA challenge to resolve via /auth/mfa-verify.'),
          ...errs({
            ...OAUTH_CONFIG_ERRORS,
            400: OAUTH_CONFIG_ERRORS[400] + '; or OAUTH_NO_EMAIL — the provider returned no email.',
            401: 'OAUTH_EMAIL_NOT_VERIFIED — the provider reports the email as unverified.',
            403:
              'OPERATOR_SIGNUP_CLOSED — sign-up is disabled on this deployment (only if this ' +
              'login would create a new operator); or OPERATOR_INVITE_REQUIRED — invite mode ' +
              'requires `inviteKey`; or OPERATOR_INVITE_INVALID — the invite key does not ' +
              'match a pending invite; or OPERATOR_INVITE_EXPIRED — the invite has expired; ' +
              'or NO_TENANT_MEMBERSHIPS — the operator has no workspace memberships.',
            409: 'OPERATOR_INVITE_USED — the invite was already consumed (race lost).',
          }),
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const { code, state, inviteKey } = CallbackBody.parse(req.body);
      const result = await tenantOAuthService.handleCallback({
        provider,
        code,
        ...(state !== undefined && { state }),
        ...(inviteKey !== undefined && { inviteKey }),
        device: deviceContext(req as { headers: Record<string, unknown>; ip: string }),
      });
      return { success: true, data: result };
    },
  );

  // ---- Operator sign-in by ID Token assertion -----------------------------
  //
  // Establishes an operator session from an OIDC ID Token this deployment
  // issued for the Application named by OPERATOR_OIDC_ISSUER. It is how a
  // Rekey Cloud buyer reaches the panel with the account they already signed
  // in with on the marketing site, instead of being handed an invite key to
  // paste — but nothing here knows about Rekey Cloud, billing, or invites.
  //
  // 404 rather than 403 when unconfigured: a deployment that has not opted in
  // should not advertise that the surface exists.
  app.post(
    '/oidc/assert',
    {
      config: { rateLimit: authRateLimit(20) },
      schema: {
        tags: ['Tenant · OAuth'],
        security: [],
        summary: 'Establish an operator session from a trusted OIDC ID Token',
        description:
          'Accepts an ID Token minted by this deployment for the Application configured as ' +
          '`OPERATOR_OIDC_ISSUER`, carrying `OPERATOR_OIDC_CLIENT_ID` as its audience. The ' +
          'token must be unexpired, carry a verified email, and has not been redeemed before — ' +
          'assertions are single-use. Matches an existing operator by verified email, and ' +
          'otherwise creates one subject to `OPERATOR_SIGNUP_MODE` exactly like any other ' +
          'first sign-in.',
        body: {
          type: 'object',
          required: ['idToken'],
          properties: { idToken: { type: 'string', minLength: 1, maxLength: 8192 } },
        },
        response: {
          200: ok(TenantSignInOutcome, 'A session, or an MFA challenge to resolve via /auth/mfa-verify.'),
          ...errs({
            401: 'OIDC_ASSERTION_INVALID — the token is unverifiable, expired, for another issuer or audience, carries an unverified email, or has already been redeemed.',
            403:
              'OPERATOR_SIGNUP_CLOSED / OPERATOR_INVITE_REQUIRED — this assertion would create a ' +
              'new operator and the deployment does not permit it; or NO_TENANT_MEMBERSHIPS.',
            404: 'OIDC_ASSERTION_NOT_CONFIGURED — this deployment accepts no ID Token assertions.',
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
            503: 'DEPENDENCY_UNAVAILABLE — the replay store is unreachable, so single-use cannot be guaranteed.',
          }),
        },
      },
    },
    async (req) => {
      const { idToken } = AssertBody.parse(req.body);
      const result = await tenantOAuthService.handleIdTokenAssertion({
        idToken,
        device: deviceContext(req as { headers: Record<string, unknown>; ip: string }),
      });
      return { success: true, data: result };
    },
  );
}
