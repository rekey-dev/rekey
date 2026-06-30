/**
 * Operator MCP OAuth 2.1 routes.
 *
 * Mounted at /api/v1/tenant/mcp. Mirrors the per-Application MCP OAuth route
 * shape (modules/mcp/mcp.routes.ts) but binds tokens to (tenantUserId,
 * tenantId) the operator picks at the consent page.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414
 *   GET  /.well-known/oauth-protected-resource     RFC 9728
 *   POST /oauth/register                            RFC 7591
 *   GET  /oauth/authorize                            login + workspace pick + consent (HTML)
 *   POST /oauth/authorize                            submit
 *   POST /oauth/token                                authorization_code + refresh_token grants
 *   POST /oauth/introspect                           RFC 7662
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authRateLimit } from '../../lib/rate-limit.js';
import {
  OAuthError,
  OPERATOR_MCP_SCOPE,
  operatorAuthServerMetadata,
  operatorMcpIssuer,
  operatorMcpOAuthService,
  operatorProtectedResourceMetadata,
} from './oauth.service.js';

// --- HTML rendering for the consent page -----------------------------------

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

interface RenderArgs {
  actionUrl: string;
  clientName: string;
  params: AuthorizeParams;
  error?: string | undefined;
  /**
   * Memberships array — only relevant once we've authenticated the operator.
   * `undefined` = render the email/password login. Non-empty = render the
   * workspace picker. Empty list = no workspaces (error).
   */
  memberships?:
    | Array<{ tenantId: string; tenantName: string; role: string }>
    | undefined;
  /**
   * Short-lived signed token proving the login step succeeded — carried in a
   * hidden field so the workspace-pick step never round-trips the password.
   */
  consentToken?: string | undefined;
}

function renderAuthorizePage(opts: RenderArgs): string {
  const hidden = (
    [
      'response_type',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'scope',
      'state',
    ] as const
  )
    .map((k) => {
      const v = opts.params[k];
      return v === undefined ? '' : `<input type="hidden" name="${k}" value="${esc(String(v))}">`;
    })
    .join('\n      ');

  const styles = `body{font-family:system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#1d1e22}h2{font-size:1.125rem;margin:0 0 .25rem}label{display:block;margin:.75rem 0 .25rem;font-size:.875rem}input[type=email],input[type=password],input[type=text]{width:100%;padding:.5rem;border:1px solid #d4cec8;border-radius:.375rem;box-sizing:border-box;font-size:.875rem}button{margin-top:1rem;padding:.5rem 1rem;border-radius:.375rem;border:0;cursor:pointer;font-size:.875rem;font-weight:500}.allow{background:#0d9488;color:#fff}.deny{background:#eee;color:#1d1e22}.err{color:#b91c1c;font-size:.875rem;margin:.5rem 0;background:#fee2e2;padding:.5rem .625rem;border-radius:.375rem}.muted{color:#6f6a66;font-size:.8125rem;margin:.5rem 0}.row{display:flex;gap:.5rem;align-items:center}ul.wpicker{list-style:none;padding:0;margin:.5rem 0}ul.wpicker li{margin:.375rem 0}ul.wpicker label{cursor:pointer;display:flex;gap:.5rem;align-items:center;padding:.5rem .625rem;border:1px solid #e8e0d9;border-radius:.375rem;font-size:.875rem}ul.wpicker label:hover{background:#f3ede7}.role{color:#6f6a66;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;margin-left:auto}`;

  let body: string;
  if (opts.memberships === undefined) {
    // Step 1: login.
    body = `
  <h2>Sign in to ReliPay (operator)</h2>
  <p class="muted">${esc(opts.clientName)} wants read-only access to your workspace data — applications, end-users, payments, webhooks. You'll pick the workspace next.</p>
  ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
  <form method="post" action="${esc(opts.actionUrl)}">
      ${hidden}
    <label>Email</label><input type="email" name="email" required autocomplete="username">
    <label>Password</label><input type="password" name="password" required autocomplete="current-password">
    <div class="row"><button class="allow" type="submit" name="step" value="login">Continue</button>
    <button class="deny" type="submit" name="consent" value="deny">Cancel</button></div>
  </form>`;
  } else if (opts.memberships.length === 0) {
    body = `<h2>No workspaces</h2><p class="muted">Your operator account isn't a member of any workspace. Ask the workspace owner for an invite, then retry.</p>`;
  } else {
    // Step 2: workspace pick + consent.
    const picker = opts.memberships
      .map(
        (m, i) => `
      <li><label>
        <input type="radio" name="tenant_id" value="${esc(m.tenantId)}" ${i === 0 ? 'checked' : ''} required>
        <span>${esc(m.tenantName)}</span>
        <span class="role">${esc(m.role)}</span>
      </label></li>`,
      )
      .join('');
    body = `
  <h2>Choose workspace</h2>
  <p class="muted">${esc(opts.clientName)} will see only the workspace you pick — its applications, end-users, payments, webhooks, security events. Read-only.</p>
  ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
  <form method="post" action="${esc(opts.actionUrl)}">
      ${hidden}
      <input type="hidden" name="consent_token" value="${esc(opts.consentToken ?? '')}">
      <input type="hidden" name="step" value="consent">
    <ul class="wpicker">${picker}</ul>
    <div class="row"><button class="allow" type="submit" name="consent" value="allow">Allow</button>
    <button class="deny" type="submit" name="consent" value="deny">Deny</button></div>
  </form>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReliPay — operator MCP authorize</title>
<style>${styles}</style>
</head><body>${body}</body></html>`;
}

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

  // ─── Authorization endpoint ────────────────────────────────────────
  //
  // Two-step flow:
  //   1. GET /oauth/authorize  → render login form (email + password)
  //   2. POST /oauth/authorize with `step=login`  → verify creds, render
  //      workspace picker + consent buttons
  //   3. POST /oauth/authorize with `step=consent`+`tenant_id` → mint code,
  //      redirect to client.
  //
  // The login step mints a short-lived signed consent token that the
  // workspace-pick form carries in a hidden field — the password is verified
  // once and never echoed back into HTML. Step 3 validates the token and
  // re-reads memberships from the DB before minting the code. No session
  // cookie / server-side state needed for this short same-origin round-trip.
  app.get(
    '/oauth/authorize',
    {
      schema: { tags: ['MCP · Operator · OAuth'], summary: 'Authorization endpoint (login)' },
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
      if (q.data.response_type !== 'code' || q.data.code_challenge_method !== 'S256') {
        const u = new URL(q.data.redirect_uri);
        u.searchParams.set('error', 'invalid_request');
        if (q.data.state) u.searchParams.set('state', q.data.state);
        return reply.redirect(u.toString());
      }
      return reply.type('text/html').send(
        renderAuthorizePage({
          actionUrl: `/api/v1/tenant/mcp/oauth/authorize`,
          clientName: client.clientName ?? 'An application',
          params: q.data,
        }),
      );
    },
  );

  app.post(
    '/oauth/authorize',
    {
      config: { rateLimit: authRateLimit(10) },
      schema: { tags: ['MCP · Operator · OAuth'], summary: 'Submit login / workspace pick / consent' },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string>;
      const q = AuthorizeQuery.safeParse(body);
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
      const params = q.data;
      const redirectWith = (extra: Record<string, string>): unknown => {
        const u = new URL(params.redirect_uri);
        for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
        if (params.state) u.searchParams.set('state', params.state);
        return reply.redirect(u.toString());
      };
      const renderError = (
        message: string | undefined,
        memberships?: Array<{ tenantId: string; tenantName: string; role: string }>,
        consentToken?: string,
      ): unknown =>
        reply.type('text/html').send(
          renderAuthorizePage({
            actionUrl: `/api/v1/tenant/mcp/oauth/authorize`,
            clientName: client.clientName ?? 'An application',
            params,
            error: message,
            memberships,
            consentToken,
          }),
        );

      // Cancel button (no consent) — RFC 6749 §4.1.2.1 says use `access_denied`.
      if (body.consent === 'deny') return redirectWith({ error: 'access_denied' });

      // Step 2: consent submitted. The hidden `consent_token` (minted at the
      // login step) proves the password check passed — the password itself is
      // never echoed back into the page. Memberships are re-read from the DB
      // so a revoked membership can't be consented to with a stale token.
      if (body.step === 'consent') {
        const tenantUserId = operatorMcpOAuthService.verifyConsentToken(
          String(body.consent_token ?? ''),
          q.data.client_id,
        );
        if (!tenantUserId) {
          return renderError('Your sign-in expired — please sign in again.');
        }
        const memberships = await operatorMcpOAuthService.membershipsForConsent(tenantUserId);
        const freshToken = operatorMcpOAuthService.issueConsentToken(
          tenantUserId,
          q.data.client_id,
        );
        const tenantId = String(body.tenant_id ?? '').trim();
        if (!tenantId) {
          return renderError('Pick a workspace to continue.', memberships, freshToken);
        }
        const membership = memberships.find((m) => m.tenantId === tenantId);
        if (!membership) {
          return renderError('That workspace is not one of yours.', memberships, freshToken);
        }
        if (body.consent !== 'allow') return redirectWith({ error: 'access_denied' });

        const code = await operatorMcpOAuthService.createAuthCode({
          clientId: q.data.client_id,
          tenantUserId,
          tenantId,
          redirectUri: q.data.redirect_uri,
          codeChallenge: q.data.code_challenge,
          scope: q.data.scope ?? OPERATOR_MCP_SCOPE,
        });
        return redirectWith({ code });
      }

      // Step 1: login. Verify credentials, then mint the consent token the
      // workspace-pick form carries instead of the raw credentials.
      const email = String(body.email ?? '').trim();
      const password = String(body.password ?? '');
      if (!email || !password) return renderError('Email and password are required.');

      const auth = await operatorMcpOAuthService.signInForConsent(email, password);
      if (!auth) return renderError('Email or password is incorrect.');

      return renderError(
        undefined, // no error — clear panel
        auth.memberships,
        operatorMcpOAuthService.issueConsentToken(auth.tenantUserId, q.data.client_id),
      );
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
