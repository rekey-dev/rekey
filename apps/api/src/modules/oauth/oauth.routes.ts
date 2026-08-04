/**
 * Public OAuth endpoints — used by the customers' apps to sign their
 * end-users in via Google / GitHub / etc.
 *
 *   POST /api/v1/auth/oauth/:provider/start    { state, ... }
 *     → { authorizationUrl }
 *     The customer's app redirects the browser to authorizationUrl. The
 *     `state` is the CSRF guard the customer must round-trip.
 *
 *   POST /api/v1/auth/oauth/:provider/callback { code }
 *     → { endUser, accessToken, refreshToken, ... }
 *     The customer's server hits this with the `code` query param it
 *     received at its registered redirectUri. We exchange + match-or-create
 *     + issue tokens.
 *
 * Admin endpoints (under /api/v1/tenant/applications/:id/oauth-config) live
 * in tenant-applications.routes.ts.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { oauthService } from './oauth.service.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { shapeSignInOutcome } from '../auth/auth.routes.js';
import { ok, okArray, errs, ref } from '../../lib/openapi.js';

const ProviderParam = z.object({ provider: z.string().min(1).max(40) });
const StartBody = z.object({ state: z.string().min(1).max(512) });
const CallbackBody = z.object({ code: z.string().min(1).max(4096) });

/**
 * Errors from `requirePublishableOrSecretKey` + `requireScope('auth:write')`
 * — every route in this module runs both as `onRequest` hooks.
 */
const KEY_ERRORS = {
  401:
    'API_KEY_MISSING — no `Authorization: Bearer` header; or API_KEY_INVALID — the secret ' +
    'key is unknown, revoked, or expired; or PUBLISHABLE_KEY_INVALID — the publishable key ' +
    'is unknown or was rotated out.',
  403:
    'IP_NOT_ALLOWED — caller IP is outside the secret key\'s IP allowlist; or ' +
    'ORIGIN_NOT_ALLOWED — the browser `Origin` is outside the publishable key\'s CORS ' +
    'allowlist; or API_KEY_SCOPE_INSUFFICIENT — the secret key lacks the `auth:write` scope.',
  429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
} as const;

/** Additionally required by `oauthLinkRoutes` — `requireUserSession` runs after the key hooks. */
const USER_SESSION_ERRORS = {
  401:
    `${KEY_ERRORS[401]}; or USER_TOKEN_MISSING — no \`X-Rekey-User-Token\` header; or ` +
    'USER_TOKEN_INVALID — the user token is invalid, expired, or wrongly signed; or ' +
    'USER_TOKEN_WRONG_APPLICATION — the token was issued by a different Application; or ' +
    'IMPERSONATION_SESSION_ENDED — the impersonation session behind this token has ended.',
  403: KEY_ERRORS[403],
  429: KEY_ERRORS[429],
} as const;

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // Pre-user OAuth login (start + callback) — part of the public-bootstrap
  // surface, so a browser-only app reaches it with the publishable key. The
  // account-linking routes below also accept it: they are authorized by the
  // signed-in user's JWT (`requireUserSession`), not by the key tier.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:write'));

  app.post(
    '/:provider/start',
    {
      schema: {
        tags: ['Public · OAuth'],
        summary: 'Get the authorization URL for an OAuth provider',
        description:
          'Returns the URL the browser should be redirected to. Pass an unguessable `state` to round-trip; verify it on callback before calling /callback here.',
        params: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
        body: {
          type: 'object',
          required: ['state'],
          properties: { state: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        security: [{ apiKey: [] }, { publishableKey: [] }],
        response: {
          // No redirect happens here — this route returns JSON. It is the
          // *customer's* app that redirects the end-user's browser to
          // `authorizationUrl`; the API never issues a 3xx itself.
          200: ok(
            {
              type: 'object',
              properties: { authorizationUrl: { type: 'string', format: 'uri' } },
              required: ['authorizationUrl'],
            },
            'The URL to redirect the browser to.',
          ),
          ...errs({
            400:
              'BAD_REQUEST — `state` is missing or too long; or OAUTH_PROVIDER_NOT_CONFIGURED ' +
              '— this Application has no config (or no client secret) for this provider.',
            ...KEY_ERRORS,
            404: 'OAUTH_PROVIDER_UNKNOWN — the provider is not registered (use google or github).',
          }),
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const body = StartBody.parse(req.body);
      const url = await oauthService.buildAuthUrl({
        application: req.application!,
        providerName: provider,
        state: body.state,
      });
      return { success: true, data: { authorizationUrl: url } };
    },
  );

  app.post(
    '/:provider/callback',
    {
      schema: {
        tags: ['Public · OAuth'],
        summary: 'Exchange an OAuth code for a Rekey session',
        description:
          'Pass the `code` query param from the provider callback. Returns a fresh access+refresh pair for the matched-or-created EndUser. Verify state CSRF *before* calling.',
        params: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
        security: [{ apiKey: [] }, { publishableKey: [] }],
        response: {
          // No redirect — this route returns JSON (a session, or an MFA
          // challenge). The customer's *server* calls it after their app
          // already received `code` at their own registered redirect URI.
          200: ok(
            ref('SignInOutcome'),
            'Either a finished session, or `mfaRequired: true` + a challenge token to ' +
              'exchange at POST /api/v1/auth/mfa-verify.',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR — `code` is missing or too long; or ' +
              'OAUTH_PROVIDER_NOT_CONFIGURED — this Application has no config (or no client ' +
              'secret) for this provider; or OAUTH_NO_EMAIL — the provider did not return an ' +
              'email, so a new user cannot be created.',
            401:
              `${KEY_ERRORS[401]}; or OAUTH_IDENTITY_WRONG_APPLICATION — defence-in-depth, ` +
              'should be unreachable via normal flows; or OAUTH_EMAIL_NOT_VERIFIED — the ' +
              'provider did not verify the email and a local account with that email already ' +
              'exists (sign in with it, then link this provider explicitly instead).',
            403:
              `${KEY_ERRORS[403]}; or SIGNUP_DISABLED — this Application does not allow new ` +
              'sign-ups; or SIGNUP_REQUIRES_SECRET_KEY — OAuth-first sign-up needs a ' +
              'secret-key caller on this Application; or TENANT_QUOTA_EXCEEDED — the ' +
              "workspace's end-user limit would be exceeded by creating this user.",
            404: 'OAUTH_PROVIDER_UNKNOWN — the provider is not registered (use google or github).',
            429: KEY_ERRORS[429],
          }),
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const body = CallbackBody.parse(req.body);
      const ua = req.headers['user-agent'];
      const outcome = await oauthService.handleCallback({
        application: req.application!,
        providerName: provider,
        code: body.code,
        device: {
          userAgent: typeof ua === 'string' && ua.length > 0 ? ua : null,
          ip: req.ip || null,
        },
        // Signup policy: refuse OAuth-first user creation via a pub key in
        // `secret_only` apps (and entirely in `invite_only`).
        ...(req.authKind !== undefined && { authKind: req.authKind }),
      });
      return { success: true, data: shapeSignInOutcome(outcome) };
    },
  );
}

/**
 * Authenticated OAuth account-linking surface.
 *
 *   GET    /api/v1/auth/oauth/identities
 *     List the providers linked to the current end-user.
 *
 *   POST   /api/v1/auth/oauth/:provider/link/start    { state }
 *     Same as unauthenticated /start but the customer's app should track
 *     the state in the user's session so they know to call /link/complete
 *     (rather than /callback) on return.
 *
 *   POST   /api/v1/auth/oauth/:provider/link/complete { code }
 *     Attach the provider identity to the *currently authenticated*
 *     user. Refuses on unverified emails (account-takeover guard) or
 *     when the provider account is already linked to a different user.
 *
 *   DELETE /api/v1/auth/oauth/:provider
 *     Remove the link. Refuses if it would leave the account with no
 *     sign-in method (no password + no other OAuth) — lockout guard.
 */
export async function oauthLinkRoutes(app: FastifyInstance): Promise<void> {
  // Same credential tier as the `/:provider/start` + `/callback` sign-in
  // siblings. `requireUserSession` is the gate: linking always targets
  // `req.endUser`, so OAuth sign-in and OAuth linking are reachable from the
  // same browser client instead of only the former.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:write'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/identities',
    {
      schema: {
        tags: ['Public · OAuth'],
        summary: 'List OAuth providers linked to the current user',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          // Bounded by construction — the set of OAuth providers a deployment
          // registers, not tenant data. A bare array is correct here.
          200: okArray(
            {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                providerAccountId: { type: 'string' },
                email: { type: 'string', format: 'email', nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
              },
              required: ['provider', 'providerAccountId', 'email', 'createdAt'],
            },
            'The OAuth identities linked to the current user.',
          ),
          ...errs(USER_SESSION_ERRORS),
        },
      },
    },
    async (req) => ({
      success: true,
      data: (await oauthService.listIdentities(req.endUser!.id)).map((i) => ({
        ...i,
        createdAt: i.createdAt.toISOString(),
      })),
    }),
  );

  app.post(
    '/:provider/link/start',
    {
      schema: {
        tags: ['Public · OAuth'],
        summary: 'Begin an OAuth link flow for the current user',
        params: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
        body: {
          type: 'object',
          required: ['state'],
          properties: { state: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          // No redirect — returns JSON, same contract as the unauthenticated
          // /:provider/start above.
          200: ok(
            {
              type: 'object',
              properties: { authorizationUrl: { type: 'string', format: 'uri' } },
              required: ['authorizationUrl'],
            },
            'The URL to redirect the browser to.',
          ),
          ...errs({
            400:
              'BAD_REQUEST — `state` is missing or too long; or OAUTH_PROVIDER_NOT_CONFIGURED ' +
              '— this Application has no config (or no client secret) for this provider.',
            ...USER_SESSION_ERRORS,
            404: 'OAUTH_PROVIDER_UNKNOWN — the provider is not registered (use google or github).',
          }),
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const body = StartBody.parse(req.body);
      const url = await oauthService.buildLinkAuthUrl({
        application: req.application!,
        providerName: provider,
        state: body.state,
      });
      return { success: true, data: { authorizationUrl: url } };
    },
  );

  app.post(
    '/:provider/link/complete',
    {
      schema: {
        tags: ['Public · OAuth'],
        summary: 'Complete an OAuth link — attaches the provider identity to the current user',
        params: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                providerAccountId: { type: 'string' },
                alreadyLinked: {
                  type: 'boolean',
                  description: 'True when this provider account was already linked to this same user (idempotent).',
                },
              },
              required: ['provider', 'providerAccountId', 'alreadyLinked'],
            },
            'The link result.',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR — `code` is missing or too long; or ' +
              'OAUTH_PROVIDER_NOT_CONFIGURED — this Application has no config (or no client ' +
              'secret) for this provider.',
            401:
              `${USER_SESSION_ERRORS[401]}; or OAUTH_EMAIL_NOT_VERIFIED — the provider did ` +
              'not verify the email; refusing to link.',
            403: USER_SESSION_ERRORS[403],
            404: 'OAUTH_PROVIDER_UNKNOWN — the provider is not registered (use google or github).',
            409: 'OAUTH_IDENTITY_TAKEN — this provider account is already linked to a different user.',
            429: USER_SESSION_ERRORS[429],
          }),
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const body = CallbackBody.parse(req.body);
      const result = await oauthService.linkIdentity({
        application: req.application!,
        providerName: provider,
        code: body.code,
        endUserId: req.endUser!.id,
      });
      return { success: true, data: result };
    },
  );

  app.delete(
    '/:provider',
    {
      schema: {
        tags: ['Public · OAuth'],
        summary: 'Remove an OAuth provider from the current user. Refuses if it would lock the account out.',
        params: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                unlinked: {
                  type: 'boolean',
                  description: 'False when this provider was not linked to begin with.',
                },
              },
              required: ['unlinked'],
            },
            'The unlink result.',
          ),
          ...errs({
            ...USER_SESSION_ERRORS,
            404: 'END_USER_NOT_FOUND — the current user no longer exists in this Application.',
            409:
              'OAUTH_UNLINK_WOULD_LOCK_OUT — removing this provider would leave the account ' +
              'with no way to sign in (no password and no other linked provider).',
          }),
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const result = await oauthService.unlinkIdentity({
        application: req.application!,
        providerName: provider,
        endUserId: req.endUser!.id,
      });
      return { success: true, data: result };
    },
  );
}
