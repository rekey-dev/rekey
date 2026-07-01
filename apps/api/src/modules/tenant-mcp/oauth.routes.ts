/**
 * Operator MCP OAuth 2.1 routes.
 *
 * Mounted at /api/v1/tenant/mcp. Tokens bind to a (tenantUserId, tenantId) pair
 * the operator picks at consent.
 *
 * The operator NEVER signs in on the API. `GET /oauth/authorize` validates the
 * client + PKCE then redirects the browser to the panel's `/mcp-consent` page,
 * where the operator authenticates through the REAL panel login (existing
 * session, passkeys, MFA, magic-link) and picks a workspace. The panel then
 * calls the authenticated `POST /oauth/grant` with the operator's session
 * bearer; that endpoint mints the authorization code and hands back the client
 * redirect URL. This replaces the previous bespoke email+password form, which
 * bypassed MFA and the brute-force lockout.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414
 *   GET  /.well-known/oauth-protected-resource     RFC 9728
 *   POST /oauth/register                            RFC 7591
 *   GET  /oauth/authorize                            → 302 to panel /mcp-consent
 *   POST /oauth/grant                                operator-session-authed; mints the code
 *   POST /oauth/token                                authorization_code + refresh_token grants
 *   POST /oauth/introspect                           RFC 7662
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { RelipayError } from '../../lib/error.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import {
  OAuthError,
  grantScopes,
  operatorAuthServerMetadata,
  operatorMcpIssuer,
  operatorMcpOAuthService,
  operatorProtectedResourceMetadata,
} from './oauth.service.js';

// --- Zod schemas -----------------------------------------------------------

const AuthorizeQuery = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1).max(256),
  code_challenge_method: z.string(),
  scope: z.string().max(256).optional(),
  state: z.string().max(512).optional(),
});

/** The panel posts this after the operator authenticates + picks a workspace. */
const GrantBody = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1).max(256),
  code_challenge_method: z.string(),
  scope: z.string().max(256).optional(),
  state: z.string().max(512).optional(),
  tenant_id: z.string().min(1),
  /** false = the operator clicked Deny on the consent screen. */
  approve: z.boolean(),
});

const RegisterBody = z.object({
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  client_name: z.string().max(120).optional(),
});

const TokenBody = z.object({
  grant_type: z.string(),
  code: z.string().optional(),
  code_verifier: z.string().min(43).max(128).optional(),
  refresh_token: z.string().optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().min(1),
});

const IntrospectBody = z.object({
  token: z.string().min(1),
});

/** Append params to a client redirect URI, preserving an opaque `state`. */
function buildRedirect(redirectUri: string, extra: Record<string, string>, state?: string): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

// --- Routes ----------------------------------------------------------------

/** Single Fastify plugin mounting every operator-MCP OAuth route. */
export async function operatorMcpOAuthRoutes(app: FastifyInstance): Promise<void> {
  // ─── Discovery — RFC 8414 + RFC 9728 ───────────────────────────────
  app.get(
    '/.well-known/oauth-authorization-server',
    {
      schema: {
        tags: ['MCP · Operator · OAuth'],
        summary: 'Authorization-server metadata (RFC 8414)',
      },
    },
    async () => operatorAuthServerMetadata(),
  );

  app.get(
    '/.well-known/oauth-protected-resource',
    {
      schema: {
        tags: ['MCP · Operator · OAuth'],
        summary: 'Protected-resource metadata (RFC 9728)',
      },
    },
    async () => operatorProtectedResourceMetadata(),
  );

  // ─── RFC 7591 dynamic client registration ──────────────────────────
  app.post(
    '/oauth/register',
    {
      config: { rateLimit: authRateLimit(20) },
      schema: {
        tags: ['MCP · Operator · OAuth'],
        summary: 'Dynamic client registration (RFC 7591)',
        body: {
          type: 'object',
          required: ['redirect_uris'],
          properties: {
            redirect_uris: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: { type: 'string', minLength: 1, maxLength: 2048 },
            },
            client_name: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = RegisterBody.parse(req.body);
      const result = await operatorMcpOAuthService.registerClient({
        redirectUris: body.redirect_uris,
        ...(body.client_name !== undefined && { clientName: body.client_name }),
      });
      return reply.status(201).send(result);
    },
  );

  // ─── Authorization endpoint — delegate sign-in to the panel ─────────
  //
  // Validate the client, redirect_uri, and PKCE up front (so a bad client is
  // rejected before we bounce anywhere), then 302 to the panel's consent page
  // carrying the OAuth params verbatim. The operator authenticates there with
  // the full panel login; the panel calls POST /oauth/grant to finish.
  app.get(
    '/oauth/authorize',
    {
      schema: { tags: ['MCP · Operator · OAuth'], summary: 'Authorization endpoint → panel consent' },
    },
    async (req, reply) => {
      const q = AuthorizeQuery.safeParse(req.query);
      if (!q.success) {
        return reply.type('text/html').code(400).send('<p>Invalid authorization request.</p>');
      }
      const client = await operatorMcpOAuthService.getClient(q.data.client_id);
      if (!client || !client.redirectUris.includes(q.data.redirect_uri)) {
        return reply
          .type('text/html')
          .code(400)
          .send('<p>Unknown client_id or unregistered redirect_uri.</p>');
      }
      // PKCE S256 + code response are the only shape we support. Surface the
      // failure to the client via its redirect_uri (already allowlisted above).
      if (q.data.response_type !== 'code' || q.data.code_challenge_method !== 'S256') {
        return reply.redirect(
          buildRedirect(q.data.redirect_uri, { error: 'invalid_request' }, q.data.state),
        );
      }
      const consent = new URL('/mcp-consent', env.PANEL_URL);
      for (const [k, v] of Object.entries(q.data)) {
        if (v !== undefined) consent.searchParams.set(k, String(v));
      }
      return reply.redirect(consent.toString());
    },
  );

  // ─── Grant endpoint — operator-session authenticated ────────────────
  //
  // Called by the panel's /mcp-consent page after the operator authenticated
  // (full login: MFA + lockout already enforced by the session) and picked a
  // workspace. `requireTenantSession` populates req.tenantUser. We re-validate
  // the client + redirect_uri + PKCE, confirm the operator is a member of the
  // chosen workspace, then mint the code. Returns the client redirect URL for
  // the panel to send the browser to. The session bearer IS the CSRF guard —
  // it can't be forged cross-site.
  app.post(
    '/oauth/grant',
    {
      onRequest: requireTenantSession,
      config: { rateLimit: authRateLimit(30) },
      schema: { tags: ['MCP · Operator · OAuth'], summary: 'Mint an authorization code (panel consent)' },
    },
    async (req, reply) => {
      const body = GrantBody.safeParse(req.body);
      if (!body.success) {
        throw new RelipayError({
          statusCode: 400,
          code: 'MCP_GRANT_INVALID',
          message: 'Grant body did not parse.',
          fix: 'Send the OAuth params the authorize redirect carried, plus tenant_id and approve.',
        });
      }
      const operator = req.tenantUser;
      if (!operator) {
        throw new RelipayError({
          statusCode: 401,
          code: 'OPERATOR_MCP_UNAUTHORIZED',
          message: 'No authenticated operator.',
          fix: 'Sign in to the panel first.',
        });
      }
      const data = body.data;
      const client = await operatorMcpOAuthService.getClient(data.client_id);
      if (!client || !client.redirectUris.includes(data.redirect_uri)) {
        // Don't redirect to an unvalidated URI — refuse outright.
        throw new RelipayError({
          statusCode: 400,
          code: 'MCP_GRANT_INVALID_CLIENT',
          message: 'Unknown client_id or unregistered redirect_uri.',
          fix: 'The MCP client must register (RFC 7591) before authorizing.',
        });
      }
      if (data.code_challenge_method !== 'S256') {
        throw new RelipayError({
          statusCode: 400,
          code: 'MCP_GRANT_PKCE_REQUIRED',
          message: 'Only PKCE S256 is supported.',
          fix: 'Use code_challenge_method=S256.',
        });
      }

      // Operator clicked Deny. Wrap in the standard { success, data } envelope —
      // the panel's api() helper unwraps `.data`, so a bare { redirect } would
      // read back as undefined and the consent page would never redirect.
      if (!data.approve) {
        return reply.send({
          success: true,
          data: {
            redirect: buildRedirect(data.redirect_uri, { error: 'access_denied' }, data.state),
          },
        });
      }

      // The operator may consent for ANY workspace they belong to — not just
      // their active session workspace. Re-check membership against the DB.
      const role = await operatorMcpOAuthService.memberRole(operator.id, data.tenant_id);
      if (!role) {
        throw new RelipayError({
          statusCode: 403,
          code: 'TENANT_MEMBERSHIP_REQUIRED',
          message: 'You are not a member of the chosen workspace.',
          fix: 'Pick a workspace you belong to.',
        });
      }

      const code = await operatorMcpOAuthService.createAuthCode({
        clientId: data.client_id,
        tenantUserId: operator.id,
        tenantId: data.tenant_id,
        redirectUri: data.redirect_uri,
        codeChallenge: data.code_challenge,
        scope: grantScopes(data.scope),
      });
      return reply.send({
        success: true,
        data: { redirect: buildRedirect(data.redirect_uri, { code }, data.state) },
      });
    },
  );

  // ─── Token endpoint — RFC 6749 ──────────────────────────────────────
  app.post(
    '/oauth/token',
    {
      config: { rateLimit: authRateLimit(20) },
      schema: { tags: ['MCP · Operator · OAuth'], summary: 'Token endpoint' },
    },
    async (req, reply) => {
      const body = TokenBody.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'Body did not parse.' });
      }
      try {
        const ua = req.headers['user-agent'] ?? '';
        const userAgent = typeof ua === 'string' ? ua.slice(0, 200) : undefined;
        const ip = req.ip || undefined;
        if (body.data.grant_type === 'authorization_code') {
          if (!body.data.code || !body.data.code_verifier || !body.data.redirect_uri) {
            return reply
              .status(400)
              .send({ error: 'invalid_request', error_description: 'code, code_verifier, redirect_uri are required.' });
          }
          const out = await operatorMcpOAuthService.exchangeCode({
            code: body.data.code,
            codeVerifier: body.data.code_verifier,
            redirectUri: body.data.redirect_uri,
            clientId: body.data.client_id,
            userAgent,
            ip,
          });
          return reply.send(out);
        }
        if (body.data.grant_type === 'refresh_token') {
          if (!body.data.refresh_token) {
            return reply
              .status(400)
              .send({ error: 'invalid_request', error_description: 'refresh_token is required.' });
          }
          const out = await operatorMcpOAuthService.refreshGrant({
            refreshToken: body.data.refresh_token,
            clientId: body.data.client_id,
            userAgent,
            ip,
          });
          return reply.send(out);
        }
        return reply.status(400).send({
          error: 'unsupported_grant_type',
          error_description: `grant_type "${body.data.grant_type}" is not supported.`,
        });
      } catch (err) {
        if (err instanceof OAuthError) {
          return reply.status(err.status).send({
            error: err.error,
            error_description: err.errorDescription,
          });
        }
        throw err;
      }
    },
  );

  // ─── Introspection — RFC 7662 ───────────────────────────────────────
  app.post(
    '/oauth/introspect',
    {
      schema: { tags: ['MCP · Operator · OAuth'], summary: 'Token introspection (RFC 7662)' },
    },
    async (req, reply) => {
      const body = IntrospectBody.safeParse(req.body);
      if (!body.success) return reply.send({ active: false });
      return reply.send(operatorMcpOAuthService.introspect(body.data.token));
    },
  );
}

/** The MCP resource URL — re-export so callers don't have to import the service. */
export { operatorMcpIssuer };
