/**
 * Per-Application MCP + OAuth 2.1 authorization-server routes.
 *
 * Mounted at `/api/v1/mcp`. Every path carries the Application `:slug` and is
 * gated by `authConfig.mcpEnabled` (resolveMcpApp → 404 when off). These are
 * unauthenticated OAuth/MCP discovery + registration endpoints; the authorize/
 * token/introspect endpoints and the MCP resource server land in later
 * increments.
 *
 * Responses use the standard OAuth/RFC JSON shapes (top-level fields), NOT the
 * ReliPay `{ success, data }` envelope — MCP/OAuth clients expect the spec shape.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  resolveMcpApp,
  authServerMetadata,
  protectedResourceMetadata,
  mcpOAuthService,
  mcpIssuer,
  OAuthError,
  MCP_SCOPE,
} from './oauth.service.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { authService } from '../auth/auth.service.js';
import { apiKeysService } from '../api-keys/api-keys.service.js';
import { RelipayError } from '../../lib/error.js';
import { verifyMcpAccessToken } from '../../lib/jwt.js';
import { handleMcpMessage, type JsonRpcMessage } from './mcp-server.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

/** HTML-escape untrusted values interpolated into the consent page. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string | undefined;
  state?: string | undefined;
}

/** Minimal server-rendered login + consent page for the authorization endpoint. */
function renderAuthorizePage(opts: {
  actionUrl: string;
  appName: string;
  clientName: string;
  params: AuthorizeParams;
  error?: string;
  mfa?: boolean;
}): string {
  const hidden = (['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state'] as const)
    .map((k) => {
      const v = opts.params[k];
      return v === undefined ? '' : `<input type="hidden" name="${k}" value="${esc(String(v))}">`;
    })
    .join('\n      ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${esc(opts.appName)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.75rem 0 .25rem;font-size:.875rem}input[type=email],input[type=password],input[type=text]{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:.375rem;box-sizing:border-box}button{margin-top:1rem;padding:.5rem 1rem;border-radius:.375rem;border:0;cursor:pointer}.allow{background:#0b8;color:#fff}.deny{background:#eee}.err{color:#c00;font-size:.875rem;margin:.5rem 0}.muted{color:#666;font-size:.8125rem}</style>
</head><body>
  <h2>${esc(opts.clientName)} wants to access your ${esc(opts.appName)} account</h2>
  <p class="muted">Sign in to authorize read-only access to your account (profile, subscription, usage).</p>
  ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
  <form method="post" action="${esc(opts.actionUrl)}">
      ${hidden}
    <label>Email</label><input type="email" name="email" required autocomplete="username">
    <label>Password</label><input type="password" name="password" required autocomplete="current-password">
    ${opts.mfa ? '<label>Authenticator code</label><input type="text" name="mfaCode" inputmode="numeric" autocomplete="one-time-code">' : ''}
    <div><button class="allow" type="submit" name="consent" value="allow">Allow</button>
    <button class="deny" type="submit" name="consent" value="deny">Deny</button></div>
  </form>
</body></html>`;
}

const AuthorizeQuery = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1).max(256),
  code_challenge_method: z.string(),
  scope: z.string().max(256).optional(),
  state: z.string().max(512).optional(),
});

const RegisterBody = z.object({
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  client_name: z.string().max(120).optional(),
});

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // RFC 9728 — protected-resource metadata. The 401 from the MCP endpoint
  // (later increment) points clients here.
  app.get(
    '/:slug/.well-known/oauth-protected-resource',
    { schema: { tags: ['MCP · OAuth'], summary: 'OAuth protected-resource metadata (RFC 9728)' } },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      await resolveMcpApp(slug);
      return protectedResourceMetadata(slug);
    },
  );

  // RFC 8414 — authorization-server metadata.
  app.get(
    '/:slug/.well-known/oauth-authorization-server',
    { schema: { tags: ['MCP · OAuth'], summary: 'OAuth authorization-server metadata (RFC 8414)' } },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      await resolveMcpApp(slug);
      return authServerMetadata(slug);
    },
  );

  // RFC 7591 — dynamic client registration. Public clients (PKCE, no secret).
  app.post(
    '/:slug/oauth/register',
    {
      config: { rateLimit: authRateLimit(20) },
      schema: {
        tags: ['MCP · OAuth'],
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
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveMcpApp(slug);
      const body = RegisterBody.parse(req.body);
      const result = await mcpOAuthService.registerClient(application.id, {
        redirectUris: body.redirect_uris,
        ...(body.client_name !== undefined && { clientName: body.client_name }),
      });
      return reply.status(201).send(result);
    },
  );

  // ---- Authorization endpoint: GET renders login+consent, POST processes it ----
  app.get(
    '/:slug/oauth/authorize',
    { schema: { tags: ['MCP · OAuth'], summary: 'Authorization endpoint — login + consent page' } },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveMcpApp(slug);
      const q = AuthorizeQuery.safeParse(req.query);
      if (!q.success) {
        return reply.type('text/html').code(400).send('<p>Invalid authorization request.</p>');
      }
      const client = await mcpOAuthService.getClient(application.id, q.data.client_id);
      // Never redirect to an unvalidated URI — render an error instead.
      if (!client || !client.redirectUris.includes(q.data.redirect_uri)) {
        return reply
          .type('text/html')
          .code(400)
          .send('<p>Unknown client_id or unregistered redirect_uri.</p>');
      }
      if (q.data.response_type !== 'code' || q.data.code_challenge_method !== 'S256') {
        const u = new URL(q.data.redirect_uri);
        u.searchParams.set('error', 'invalid_request');
        if (q.data.state) u.searchParams.set('state', q.data.state);
        return reply.redirect(u.toString());
      }
      return reply.type('text/html').send(
        renderAuthorizePage({
          actionUrl: `/api/v1/mcp/${slug}/oauth/authorize`,
          appName: application.name,
          clientName: client.clientName ?? 'An application',
          params: q.data,
        }),
      );
    },
  );

  app.post(
    '/:slug/oauth/authorize',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: { tags: ['MCP · OAuth'], summary: 'Submit login + consent' },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveMcpApp(slug);
      const body = (req.body ?? {}) as Record<string, string>;
      const q = AuthorizeQuery.safeParse(body);
      if (!q.success) {
        return reply.type('text/html').code(400).send('<p>Invalid authorization request.</p>');
      }
      const client = await mcpOAuthService.getClient(application.id, q.data.client_id);
      if (!client || !client.redirectUris.includes(q.data.redirect_uri)) {
        return reply
          .type('text/html')
          .code(400)
          .send('<p>Unknown client_id or unregistered redirect_uri.</p>');
      }
      const params = q.data;
      const redirectWith = (extra: Record<string, string>): unknown => {
        const u = new URL(params.redirect_uri);
        for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
        if (params.state) u.searchParams.set('state', params.state);
        return reply.redirect(u.toString());
      };
      if (body.consent !== 'allow') return redirectWith({ error: 'access_denied' });

      const renderErr = (error: string, mfa = false): unknown =>
        reply.type('text/html').code(200).send(
          renderAuthorizePage({
            actionUrl: `/api/v1/mcp/${slug}/oauth/authorize`,
            appName: application.name,
            clientName: client.clientName ?? 'An application',
            params,
            error,
            mfa,
          }),
        );

      const email = typeof body.email === 'string' ? body.email : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const mfaCode = typeof body.mfaCode === 'string' ? body.mfaCode : '';
      let endUserId: string;
      try {
        const ua = req.headers['user-agent'];
        const outcome = await authService.signIn({
          application,
          email,
          password,
          device: { ip: req.ip, userAgent: typeof ua === 'string' ? ua : null },
        });
        if (outcome.mfaRequired) {
          if (!mfaCode) return renderErr('Enter your authenticator code to continue.', true);
          const verified = await authService.verifyMfaChallenge({
            application,
            mfaChallengeToken: outcome.mfaChallengeToken,
            code: mfaCode,
          });
          endUserId = verified.endUser.id;
        } else if (outcome.mfaEnrollmentRequired) {
          // App policy mandates MFA but this user hasn't enrolled yet. The
          // web/SDK sign-in flags this so the customer app can force enrollment;
          // the MCP authorize flow must NOT mint an access token without a
          // second factor — deny (re-render) until the user enrolls. Without
          // this, a `required`-policy app hands AI tools tokens for users who
          // have bypassed MFA entirely.
          return renderErr(
            `Two-factor authentication is required for ${application.name}. Set it up in your account, then connect again.`,
          );
        } else {
          endUserId = outcome.endUser.id;
        }
      } catch (err) {
        return renderErr(err instanceof RelipayError ? err.message : 'Sign-in failed.', Boolean(mfaCode));
      }

      const code = await mcpOAuthService.createAuthCode({
        applicationId: application.id,
        clientId: client.id,
        endUserId,
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        scope: params.scope ?? MCP_SCOPE,
      });
      return redirectWith({ code });
    },
  );

  // ---- Token endpoint (RFC 6749) — authorization_code + refresh_token grants ----
  app.post(
    '/:slug/oauth/token',
    {
      config: { rateLimit: authRateLimit(30) },
      schema: { tags: ['MCP · OAuth'], summary: 'Token endpoint' },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveMcpApp(slug);
      const body = (req.body ?? {}) as Record<string, string>;
      reply.header('Cache-Control', 'no-store');
      try {
        if (body.grant_type === 'authorization_code') {
          if (!body.code || !body.code_verifier || !body.redirect_uri || !body.client_id) {
            throw new OAuthError('invalid_request', 'Missing code, code_verifier, redirect_uri, or client_id.');
          }
          const client = await mcpOAuthService.getClient(application.id, body.client_id);
          if (!client) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
          const result = await mcpOAuthService.exchangeCode({
            application,
            code: body.code,
            codeVerifier: body.code_verifier,
            redirectUri: body.redirect_uri,
            clientId: body.client_id,
          });
          return reply.send(result);
        }
        if (body.grant_type === 'refresh_token') {
          if (!body.refresh_token || !body.client_id) {
            throw new OAuthError('invalid_request', 'Missing refresh_token or client_id.');
          }
          const result = await mcpOAuthService.refreshGrant({
            application,
            refreshToken: body.refresh_token,
            clientId: body.client_id,
          });
          return reply.send(result);
        }
        throw new OAuthError('unsupported_grant_type', `grant_type "${body.grant_type ?? ''}" is not supported.`);
      } catch (err) {
        if (err instanceof OAuthError) {
          return reply.code(err.status).send({ error: err.error, error_description: err.errorDescription });
        }
        req.log.error({ err }, 'mcp token endpoint error');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  // ---- Token introspection (RFC 7662) — for customers' own MCP servers ----
  app.post(
    '/:slug/oauth/introspect',
    {
      config: { rateLimit: authRateLimit(30) },
      schema: {
        tags: ['MCP · OAuth'],
        summary: 'Token introspection (RFC 7662). Authenticate with the app secret key.',
      },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveMcpApp(slug);
      // Token state is sensitive — never let a proxy cache an introspection result.
      reply.header('Cache-Control', 'no-store');
      const header = req.headers.authorization ?? '';
      const key = header.startsWith('Bearer ') ? header.slice(7) : '';
      const verified = key ? await apiKeysService.verify(key) : null;
      if (!verified || verified.applicationId !== application.id) {
        return reply.code(401).send({
          error: 'invalid_client',
          error_description: "Introspection requires this application's secret key.",
        });
      }
      const token = (req.body as Record<string, string> | undefined)?.token;
      if (!token) return reply.send({ active: false });
      return reply.send(mcpOAuthService.introspect(application, token));
    },
  );

  // ---- MCP resource endpoint (JSON-RPC over HTTP, Bearer mcp_access token) ----
  app.post(
    '/:slug',
    { schema: { tags: ['MCP'], summary: 'MCP server endpoint (JSON-RPC 2.0)' } },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveMcpApp(slug);
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const claims = token
        ? verifyMcpAccessToken(token, application.id, application.tokenGeneration, mcpIssuer(slug))
        : null;
      if (!claims) {
        // RFC 9728 §5.1 — point the client at the protected-resource metadata.
        return reply
          .header(
            'WWW-Authenticate',
            `Bearer resource_metadata="${mcpIssuer(slug)}/.well-known/oauth-protected-resource"`,
          )
          .code(401)
          .send({ error: 'invalid_token', error_description: 'Missing or invalid MCP access token.' });
      }
      const ctx = { applicationId: application.id, endUserId: claims.sub };
      const body = req.body as unknown;
      const messages: JsonRpcMessage[] = Array.isArray(body)
        ? (body as JsonRpcMessage[])
        : [(body ?? {}) as JsonRpcMessage];
      const responses: object[] = [];
      for (const m of messages) {
        const r = await handleMcpMessage(ctx, m);
        if (r) responses.push(r);
      }
      // Only notifications/responses in the batch → 202 with no body.
      if (responses.length === 0) return reply.code(202).send();
      return reply.send(Array.isArray(body) ? responses : responses[0]);
    },
  );

  // GET is the SSE stream in full Streamable HTTP; this JSON-mode server has no
  // server-initiated messages, so direct clients to POST.
  app.get(
    '/:slug',
    { schema: { tags: ['MCP'], summary: 'MCP endpoint — use POST (JSON-RPC)' } },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      await resolveMcpApp(slug);
      return reply
        .code(405)
        .header('Allow', 'POST')
        .send({ error: 'method_not_allowed', error_description: 'Use POST for MCP JSON-RPC.' });
    },
  );
}
