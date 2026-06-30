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
import { requireApiKey, requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { shapeSignInOutcome } from '../auth/auth.routes.js';

const ProviderParam = z.object({ provider: z.string().min(1).max(40) });
const StartBody = z.object({ state: z.string().min(1).max(512) });
const CallbackBody = z.object({ code: z.string().min(1).max(4096) });

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // Pre-user OAuth login (start + callback) — part of the public-bootstrap
  // surface, so a browser-only app reaches it with the publishable key.
  // (Account-linking routes below require an existing user and stay secret-only.)
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
        security: [{ apiKey: [] }],
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
        summary: 'Exchange an OAuth code for a ReliPay session',
        description:
          'Pass the `code` query param from the provider callback. Returns a fresh access+refresh pair for the matched-or-created EndUser. Verify state CSRF *before* calling.',
        params: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
        security: [{ apiKey: [] }],
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
        // A callback that creates the user stamps the calling key's mode.
        ...(req.dataMode !== undefined && { mode: req.dataMode }),
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
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireScope('auth:write'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/identities',
    {
      schema: {
        tags: ['Public · OAuth'],
        summary: 'List OAuth providers linked to the current user',
        security: [{ apiKey: [] }],
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
        security: [{ apiKey: [] }],
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
        security: [{ apiKey: [] }],
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
        security: [{ apiKey: [] }],
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
