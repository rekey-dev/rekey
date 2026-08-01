/**
 * Per-Application MCP + OAuth 2.1 / OpenID Connect authorization-server routes.
 *
 * Mounted at `/api/v1/mcp`. Every path carries the Application `:slug`. The
 * gate differs by what the path serves: the shared grant endpoints need EITHER
 * `authConfig.mcpEnabled` or `authConfig.oidcEnabled` (resolveAuthServerApp),
 * the MCP resource server needs `mcpEnabled` (resolveMcpApp), and the OIDC
 * discovery + userinfo endpoints need `oidcEnabled` (resolveOidcApp). All three
 * 404 when their toggle is off.
 *
 * The whole flow lives in this file: discovery and dynamic registration
 * (unauthenticated), plus authorize, token, userinfo, introspect (app secret
 * key) and the MCP resource server at `POST /:slug` (end-user MCP access token).
 *
 * Responses use the standard OAuth/RFC JSON shapes (top-level fields), NOT the
 * Rekey `{ success, data }` envelope — MCP/OAuth/OIDC clients expect the spec
 * shape.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  resolveMcpApp,
  resolveOidcApp,
  resolveAuthServerApp,
  authServerMetadata,
  openidConfiguration,
  protectedResourceMetadata,
  grantScopes,
  registrationOpen,
  mcpOAuthService,
  mcpIssuer,
  OAuthError,
  MCP_SCOPE,
} from './oauth.service.js';
import { hasScope } from './oidc.service.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { authService } from '../auth/auth.service.js';
import { apiKeysService } from '../api-keys/api-keys.service.js';
import { RekeyError } from '../../lib/error.js';
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
  nonce?: string | undefined;
}

/**
 * What each grantable scope actually gives the client, for the consent screen.
 * A consent page that doesn't say what is being consented to isn't consent —
 * and with OIDC the same form now covers "read my account through an AI tool"
 * and "let this site sign me in", which are not the same decision.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: 'Confirm who you are (sign you in)',
  profile: 'Your profile details (name, picture)',
  email: 'Your email address',
  'mcp:account': 'Read-only access to your account (profile, subscription, usage)',
};

/** Minimal server-rendered login + consent page for the authorization endpoint. */
function renderAuthorizePage(opts: {
  actionUrl: string;
  appName: string;
  clientName: string;
  params: AuthorizeParams;
  /** The scopes that WILL be granted — already filtered by `grantScopes`. */
  grantedScopes: string[];
  error?: string;
  mfa?: boolean;
}): string {
  const hidden = (['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'nonce'] as const)
    .map((k) => {
      const v = opts.params[k];
      return v === undefined ? '' : `<input type="hidden" name="${k}" value="${esc(String(v))}">`;
    })
    .join('\n      ');
  // Unknown scopes can't reach here (grantScopes drops them), but fall back to
  // the raw scope name rather than silently listing nothing if one ever does.
  const grants = opts.grantedScopes
    .map((s) => `<li>${esc(SCOPE_DESCRIPTIONS[s] ?? s)}</li>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${esc(opts.appName)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.75rem 0 .25rem;font-size:.875rem}input[type=email],input[type=password],input[type=text]{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:.375rem;box-sizing:border-box}button{margin-top:1rem;padding:.5rem 1rem;border-radius:.375rem;border:0;cursor:pointer}.allow{background:#0b8;color:#fff}.deny{background:#eee}.err{color:#c00;font-size:.875rem;margin:.5rem 0}.muted{color:#666;font-size:.8125rem}ul.scopes{color:#666;font-size:.8125rem;margin:.5rem 0;padding-left:1.25rem}</style>
</head><body>
  <h2>${esc(opts.clientName)} wants to access your ${esc(opts.appName)} account</h2>
  <p class="muted">Sign in to grant:</p>
  <ul class="scopes">${grants}</ul>
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
  // OIDC Core §3.1.2.1. Opaque to us — stored with the code and replayed into
  // the ID Token, where the relying party matches it against its own session.
  nonce: z.string().max(256).optional(),
  // Accepted only to be REFUSED correctly (see `unsupportedRequestError`); this
  // AS implements none of them.
  prompt: z.string().max(64).optional(),
  request: z.string().max(4096).optional(),
  request_uri: z.string().max(2048).optional(),
});

/**
 * Reject the parts of an authentication request this AS cannot honour, with the
 * error code the spec names for each. Returned as an OAuth error redirect (the
 * client + redirect_uri are already validated by the time this runs), never as
 * a silent downgrade — a client that asked for `prompt=none` and got a login
 * form has been lied to.
 *
 * `prompt=none` can never succeed here: there is no AS-side SSO session to
 * reuse, so every authorization re-authenticates the end-user. That also means
 * `max_age` is always satisfied and needs no handling — `auth_time` is minted
 * seconds before the code is redeemed.
 */
function unsupportedRequestError(params: {
  response_type: string;
  code_challenge_method: string;
  prompt?: string | undefined;
  request?: string | undefined;
  request_uri?: string | undefined;
}): string | null {
  // OIDC Core §6.1 / §6.2 — both MUST be refused with their own error codes
  // when request objects aren't supported (discovery says they aren't).
  if (params.request !== undefined) return 'request_not_supported';
  if (params.request_uri !== undefined) return 'request_uri_not_supported';
  if ((params.prompt ?? '').split(/\s+/).includes('none')) return 'login_required';
  if (params.response_type !== 'code') return 'unsupported_response_type';
  if (params.code_challenge_method !== 'S256') return 'invalid_request';
  return null;
}

const RegisterBody = z.object({
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  client_name: z.string().max(120).optional(),
});

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // RFC 9728 — protected-resource metadata. The 401 from the MCP endpoint
  // (`POST /:slug`, further down this file) points clients here.
  app.get(
    '/:slug/.well-known/oauth-protected-resource',
    {
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'OAuth protected-resource metadata (RFC 9728)',
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      await resolveMcpApp(slug);
      return protectedResourceMetadata(slug);
    },
  );

  // RFC 8414 — authorization-server metadata.
  app.get(
    '/:slug/.well-known/oauth-authorization-server',
    {
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'OAuth authorization-server metadata (RFC 8414)',
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveAuthServerApp(slug);
      return authServerMetadata(application);
    },
  );

  // OIDC Discovery 1.0 §4 — OpenID Provider metadata. Served at the issuer +
  // `/.well-known/openid-configuration`, which is the location OIDC mandates;
  // the path-insertion form RFC 8414 §3.1 defines for issuers with a path lives
  // in mcp.well-known.routes.ts, because it has to sit under the origin.
  app.get(
    '/:slug/.well-known/openid-configuration',
    {
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'OpenID Provider metadata (OIDC Discovery 1.0)',
        description:
          'Present only for Applications with `authConfig.oidcEnabled`; 404 otherwise. ' +
          'Every advertised capability is implemented — unsupported OIDC features are ' +
          'advertised as unsupported rather than omitted.',
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveOidcApp(slug);
      return openidConfiguration(application);
    },
  );

  // RFC 7591 — dynamic client registration. Public clients (PKCE, no secret).
  app.post(
    '/:slug/oauth/register',
    {
      // RFC 7591 clients post JSON, but some post form-encoded — both allowed.
      config: { rateLimit: authRateLimit(20), acceptsForm: true },
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'Dynamic client registration (RFC 7591)',
        description:
          'Unauthenticated (RFC 7591 open registration). Registers a PUBLIC client — PKCE, ' +
          'no client secret is issued — so there is nothing to authenticate with yet at this ' +
          'point in the flow. Governed by `authConfig.dynamicClientRegistration` (default ' +
          'on): with it off this returns 403 `CLIENT_REGISTRATION_DISABLED` and the ' +
          'discovery documents stop advertising `registration_endpoint`. Turn it off once ' +
          'your relying parties are registered — on a public OpenID Provider, open ' +
          "registration lets anyone put a password form on the operator's own issuer origin.",
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
      const application = await resolveAuthServerApp(slug);
      // 403 rather than 404: the endpoint exists and the Application is real —
      // the operator has closed it. A client that gets 404 retries a different
      // path; one that gets this knows to ask the operator for a client_id.
      if (!registrationOpen(application)) {
        throw new RekeyError({
          statusCode: 403,
          code: 'CLIENT_REGISTRATION_DISABLED',
          message: 'This Application does not accept dynamic client registration.',
          fix: 'Ask the operator to register your redirect URIs and issue you a client_id, or have them set authConfig.dynamicClientRegistration = true (Panel → Application → Auth).',
        });
      }
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
    {
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'Authorization endpoint — login + consent page',
        description:
          'Renders an HTML sign-in + consent form for a browser. No Rekey credential — ' +
          'the end user authenticates by submitting the form below.',
      },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveAuthServerApp(slug);
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
      const redirectError = (error: string): FastifyReply => {
        const u = new URL(q.data.redirect_uri);
        u.searchParams.set('error', error);
        if (q.data.state) u.searchParams.set('state', q.data.state);
        return reply.redirect(u.toString());
      };
      const unsupported = unsupportedRequestError(q.data);
      if (unsupported) return redirectError(unsupported);
      // Resolve the grant BEFORE asking for credentials: a request whose scopes
      // this Application cannot grant must fail as a protocol error, not as a
      // login form that hands back a token covering something else.
      const granted = grantScopes(application, q.data.scope);
      if (granted === '') return redirectError('invalid_scope');
      return reply.type('text/html').send(
        renderAuthorizePage({
          actionUrl: `/api/v1/mcp/${slug}/oauth/authorize`,
          appName: application.name,
          clientName: client.clientName ?? 'An application',
          params: q.data,
          grantedScopes: granted.split(' '),
        }),
      );
    },
  );

  app.post(
    '/:slug/oauth/authorize',
    {
      // Browser form POST — form-encoded by definition.
      config: { rateLimit: authRateLimit(10), acceptsForm: true },
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'Submit login + consent',
        description:
          "No Rekey credential — the end user's email + password (+ MFA code) travel in " +
          'the form body and ARE the authentication.',
      },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveAuthServerApp(slug);
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
      // Re-checked on POST, not just on GET: the hidden fields are client-side
      // and a form can be replayed with them edited.
      const unsupported = unsupportedRequestError(params);
      if (unsupported) return redirectWith({ error: unsupported });
      const granted = grantScopes(application, params.scope);
      if (granted === '') return redirectWith({ error: 'invalid_scope' });
      if (body.consent !== 'allow') return redirectWith({ error: 'access_denied' });

      const renderErr = (error: string, mfa = false): unknown =>
        reply.type('text/html').code(200).send(
          renderAuthorizePage({
            actionUrl: `/api/v1/mcp/${slug}/oauth/authorize`,
            appName: application.name,
            clientName: client.clientName ?? 'An application',
            params,
            grantedScopes: granted.split(' '),
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
        return renderErr(err instanceof RekeyError ? err.message : 'Sign-in failed.', Boolean(mfaCode));
      }

      const code = await mcpOAuthService.createAuthCode({
        applicationId: application.id,
        clientId: client.id,
        endUserId,
        redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge,
        // The GRANTED scope, not the requested one — everything downstream
        // (the access token, the ID Token, `/userinfo`, the refresh chain)
        // reads this row, so an unsupported scope must not survive past here.
        scope: granted,
        nonce: params.nonce,
        // The sign-in above is the authentication event this code attests to.
        authTime: new Date(),
      });
      return redirectWith({ code });
    },
  );

  // ---- Token endpoint (RFC 6749) — authorization_code + refresh_token grants ----
  app.post(
    '/:slug/oauth/token',
    {
      // RFC 6749 §4.1.3 mandates application/x-www-form-urlencoded.
      config: { rateLimit: authRateLimit(30), acceptsForm: true },
      schema: {
        tags: ['MCP · OAuth'],
        security: [],
        summary: 'Token endpoint (RFC 6749 — authorization_code + refresh_token)',
        description:
          'No Rekey credential and no client secret: clients here are public and prove ' +
          'themselves with PKCE. The `code` + `code_verifier` (or `refresh_token`) in the ' +
          'form body are the credential. An `id_token` (OIDC Core) is returned alongside ' +
          'the access token when the `openid` scope was granted — on the authorization_code ' +
          'grant only, never on a refresh.',
      },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveAuthServerApp(slug);
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
      // RFC 7662 §2.1 mandates application/x-www-form-urlencoded.
      config: { rateLimit: authRateLimit(30), acceptsForm: true },
      schema: {
        tags: ['MCP · OAuth'],
        security: [{ apiKey: [] }],
        summary: 'Token introspection (RFC 7662)',
        description:
          "Requires this Application's own **secret** key as `Authorization: Bearer` — the " +
          'handler verifies it and rejects a key belonging to any other Application with ' +
          '401 `invalid_client`. The publishable key is not accepted: introspection reveals ' +
          'token state. Intended for a customer running their own MCP server against ' +
          "Rekey-issued end-user MCP tokens.",
      },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveAuthServerApp(slug);
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

  // ---- UserInfo endpoint (OIDC Core §5.3) ----
  // GET and POST both, because §5.3.1 requires supporting both. The token is
  // taken ONLY from the Authorization header: RFC 6750 also allows a form field
  // and a query parameter, and this endpoint accepts neither — a query
  // parameter puts a live credential in access logs and Referer headers, and
  // discovery advertises `bearer_methods_supported: ["header"]` accordingly.
  for (const method of ['GET', 'POST'] as const) {
    app.route({
      method,
      url: '/:slug/oauth/userinfo',
      // `acceptsForm` only so a spec-compliant POST with a form content-type
      // isn't refused by the media-type guard — the body is never read. No
      // route-level rate limit: this is a bearer-protected read, like the MCP
      // endpoint below, and an RP calling it once per sign-in is normal traffic.
      // The global limiter still applies.
      config: { acceptsForm: true },
      schema: {
        tags: ['MCP · OAuth'],
        security: [{ endUserMcpToken: [] }],
        summary: 'OIDC UserInfo endpoint',
        description:
          'Returns the claims authorised by the granted scopes for the end-user the ' +
          'access token was issued to: `sub` always, `email`/`email_verified` with the ' +
          '`email` scope, profile claims with `profile`. Requires the `openid` scope — a ' +
          'token without it gets 403 `insufficient_scope`. The token must have been issued ' +
          'by THIS Application; one from another Application is `invalid_token`.',
      },
      handler: async (req, reply) => {
        const { slug } = SlugParam.parse(req.params);
        const application = await resolveOidcApp(slug);
        // Claims about a person, keyed by a bearer token — never cacheable.
        reply.header('Cache-Control', 'no-store');
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const wwwAuthenticate = (error: string, description: string): string =>
          `Bearer error="${error}", error_description="${description}"`;
        if (!token) {
          // RFC 6750 §3 — a request with NO credential gets the bare challenge.
          return reply.header('WWW-Authenticate', 'Bearer').code(401).send({
            error: 'invalid_token',
            error_description: 'Missing bearer access token.',
          });
        }
        const result = await mcpOAuthService.userInfo(application, token);
        if (!result.ok) {
          if (result.reason === 'insufficient_scope') {
            return reply
              .header(
                'WWW-Authenticate',
                `${wwwAuthenticate('insufficient_scope', 'The openid scope is required.')}, scope="openid"`,
              )
              .code(403)
              .send({
                error: 'insufficient_scope',
                error_description: 'This access token was not granted the openid scope.',
              });
          }
          return reply
            .header('WWW-Authenticate', wwwAuthenticate('invalid_token', 'The access token is invalid or expired.'))
            .code(401)
            .send({
              error: 'invalid_token',
              error_description: 'The access token is invalid, expired, or not for this application.',
            });
        }
        return reply.send(result.claims);
      },
    });
  }

  // ---- MCP resource endpoint (JSON-RPC over HTTP, Bearer mcp_access token) ----
  app.post(
    '/:slug',
    {
      schema: {
        tags: ['MCP'],
        security: [{ endUserMcpToken: [] }],
        summary: 'MCP server endpoint (JSON-RPC 2.0)',
        description:
          'Requires an **end-user** MCP access token (`Authorization: Bearer`), obtained ' +
          'through the OAuth flow above — NOT an Application key and not an operator ' +
          'credential. A missing or invalid token gets 401 plus a `WWW-Authenticate` header ' +
          'pointing at the protected-resource metadata.',
      },
    },
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
      // A valid token is not automatically an MCP token. The same AS now also
      // grants `openid` for sign-in, and an OIDC client holding a perfectly good
      // access token must not reach the account tools with it — that would make
      // "let this site sign me in" silently equal to "read my subscription".
      if (!hasScope(claims.scope, MCP_SCOPE)) {
        return reply
          .header(
            'WWW-Authenticate',
            `Bearer error="insufficient_scope", scope="${MCP_SCOPE}", resource_metadata="${mcpIssuer(slug)}/.well-known/oauth-protected-resource"`,
          )
          .code(403)
          .send({
            error: 'insufficient_scope',
            error_description: `This access token was not granted the ${MCP_SCOPE} scope.`,
          });
      }
      // GDPR erasure gate. Every tool here reads the end-user's own data —
      // `get_profile` returns their metadata verbatim — so a still-unexpired
      // token minted before the erasure must stop working the moment it lands,
      // not 15 minutes later. Same rule as the session API's
      // `assertEndUserNotErased`, phrased as an RFC 6750 challenge.
      if (!(await mcpOAuthService.grantSubjectIsLive(application.id, claims.sub))) {
        return reply
          .header(
            'WWW-Authenticate',
            `Bearer error="invalid_token", resource_metadata="${mcpIssuer(slug)}/.well-known/oauth-protected-resource"`,
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
    {
      schema: {
        tags: ['MCP'],
        security: [],
        summary: 'MCP endpoint — use POST (JSON-RPC)',
        description:
          'Always 405 with `Allow: POST`. Checks no credential, because it never does any ' +
          'work — it exists so a GET-typer sees the method violation instead of a 404.',
      },
    },
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
