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
import { randomBytes } from 'node:crypto';
import { RekeyError } from '../../lib/error.js';
import { verifyMcpAccessToken } from '../../lib/jwt.js';
import { handleMcpMessage, type JsonRpcMessage } from './mcp-server.js';
import { errs, ref, raw, type JsonSchema } from '../../lib/openapi.js';
import { requireApiKey } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { refuseWhileImpersonating } from '../../middleware/impersonation.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';

const SlugParam = z.object({ slug: z.string().min(1).max(40) });

/**
 * Body of the app-authorised session handoff. Mirrors the fields
 * `AuthorizeQuery` carries for the interactive flow, minus everything that
 * only makes sense for a browser (`response_type`, `state`, `prompt`,
 * `request`): this caller is a server and gets its code in the response body,
 * not through a redirect.
 */
const GrantBody = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1).max(256),
  code_challenge_method: z.string(),
  scope: z.string().max(256).optional(),
  nonce: z.string().max(256).optional(),
});

// ---------------------------------------------------------------------------
// Response fragments — RFC-shaped bodies, NOT the Rekey `{success, data}`
// envelope. See the module header: MCP/OAuth/OIDC clients expect the spec
// shape, so `ok()`/`errs()` (the Rekey envelope) would misdescribe them. The
// 404s these operations *can* still return (the app is missing or the
// relevant `authConfig` toggle is off — see `resolveApp` in oauth.service.ts)
// ARE the Rekey envelope, because that gate throws a `RekeyError` before any
// OAuth/OIDC logic runs.
// ---------------------------------------------------------------------------

const MCP_GATE_404 = {
  404: 'MCP_NOT_FOUND — the Application does not exist, or `authConfig.mcpEnabled` is off.',
};
const AUTH_SERVER_GATE_404 = {
  404:
    'MCP_NOT_FOUND — the Application does not exist, or neither `authConfig.mcpEnabled` nor ' +
    '`authConfig.oidcEnabled` is on.',
};
const OIDC_GATE_404 = {
  404: 'OIDC_NOT_FOUND — the Application does not exist, or `authConfig.oidcEnabled` is off.',
};

/** RFC 9728 protected-resource metadata. No registered component covers this shape. */
const ProtectedResourceMetadata: JsonSchema = {
  type: 'object',
  properties: {
    resource: { type: 'string', format: 'uri', description: 'The MCP resource / issuer URL.' },
    authorization_servers: { type: 'array', items: { type: 'string', format: 'uri' } },
    scopes_supported: { type: 'array', items: { type: 'string' } },
    bearer_methods_supported: { type: 'array', items: { type: 'string' } },
  },
  required: ['resource', 'authorization_servers'],
};

/**
 * OIDC Discovery 1.0 document. A superset of the `OAuthAuthServerMetadata`
 * component (same issuer/endpoints) plus OIDC-only fields — declared inline
 * rather than via `ref()` because the component does not model the OIDC
 * fields (`userinfo_endpoint`, `jwks_uri`, `claims_supported`, ...).
 */
const OpenIdConfiguration: JsonSchema = {
  type: 'object',
  properties: {
    issuer: { type: 'string', format: 'uri' },
    authorization_endpoint: { type: 'string', format: 'uri' },
    token_endpoint: { type: 'string', format: 'uri' },
    userinfo_endpoint: { type: 'string', format: 'uri' },
    jwks_uri: { type: 'string', format: 'uri' },
    registration_endpoint: { type: 'string', format: 'uri' },
    introspection_endpoint: { type: 'string', format: 'uri' },
    scopes_supported: { type: 'array', items: { type: 'string' } },
    response_types_supported: { type: 'array', items: { type: 'string' } },
    response_modes_supported: { type: 'array', items: { type: 'string' } },
    grant_types_supported: { type: 'array', items: { type: 'string' } },
    subject_types_supported: { type: 'array', items: { type: 'string' } },
    id_token_signing_alg_values_supported: { type: 'array', items: { type: 'string' } },
    token_endpoint_auth_methods_supported: { type: 'array', items: { type: 'string' } },
    code_challenge_methods_supported: { type: 'array', items: { type: 'string' } },
    claims_supported: { type: 'array', items: { type: 'string' } },
    claims_parameter_supported: { type: 'boolean' },
    request_parameter_supported: { type: 'boolean' },
    request_uri_parameter_supported: { type: 'boolean' },
    require_request_uri_registration: { type: 'boolean' },
  },
  required: ['issuer', 'authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri'],
};

/** RFC 7591 dynamic client registration response. Public client — no secret is issued. */
const ClientRegistrationResponse: JsonSchema = {
  type: 'object',
  properties: {
    client_id: { type: 'string' },
    client_id_issued_at: { type: 'integer', description: 'Unix seconds.' },
    client_name: { type: 'string' },
    redirect_uris: { type: 'array', items: { type: 'string' } },
    grant_types: { type: 'array', items: { type: 'string' } },
    response_types: { type: 'array', items: { type: 'string' } },
    token_endpoint_auth_method: { type: 'string', enum: ['none'] },
  },
  required: [
    'client_id',
    'redirect_uris',
    'grant_types',
    'response_types',
    'token_endpoint_auth_method',
  ],
};

/** RFC 6749 token response. */
const TokenResponse: JsonSchema = {
  type: 'object',
  properties: {
    access_token: { type: 'string' },
    token_type: { type: 'string', enum: ['Bearer'] },
    expires_in: { type: 'integer', description: 'Seconds until the access token expires.' },
    refresh_token: { type: 'string' },
    scope: { type: 'string' },
    id_token: {
      type: 'string',
      description:
        'Present only when `openid` was granted, and only on the authorization_code grant — ' +
        'never on a refresh.',
    },
  },
  required: ['access_token', 'token_type', 'expires_in', 'refresh_token', 'scope'],
};

/** RFC 6749 §5.2 error body — the shape every OAuth/OIDC failure in this file uses. */
function oauthError(description: string): JsonSchema {
  return {
    description,
    type: 'object',
    properties: {
      error: { type: 'string' },
      error_description: { type: 'string' },
    },
    required: ['error'],
  };
}

/** OIDC UserInfo claims. `sub` is unconditional; every other claim needs its scope. */
const UserInfoClaims: JsonSchema = {
  type: 'object',
  description:
    'Claims authorised by the granted scope. `sub` is always present; `email`/`email_verified` ' +
    'need the `email` scope; the rest need `profile`.',
  properties: {
    sub: { type: 'string' },
    email: { type: 'string', format: 'email' },
    email_verified: { type: 'boolean', enum: [true] },
    name: { type: 'string' },
    given_name: { type: 'string' },
    family_name: { type: 'string' },
    preferred_username: { type: 'string' },
    picture: { type: 'string' },
    updated_at: { type: 'integer', description: 'Seconds since epoch.' },
  },
  required: ['sub'],
};

const JsonRpcSuccess: JsonSchema = {
  type: 'object',
  properties: {
    jsonrpc: { type: 'string', enum: ['2.0'] },
    id: { description: 'Echoes the request id — string, number, or null.' },
    result: {
      description:
        'Present on success. Shape depends on the method (initialize / tools/list / tools/call / ping).',
    },
  },
  required: ['jsonrpc', 'id', 'result'],
};

const JsonRpcFailure: JsonSchema = {
  type: 'object',
  properties: {
    jsonrpc: { type: 'string', enum: ['2.0'] },
    id: { description: 'Echoes the request id — string, number, or null.' },
    error: {
      type: 'object',
      properties: { code: { type: 'integer' }, message: { type: 'string' } },
      required: ['code', 'message'],
    },
  },
  required: ['jsonrpc', 'id', 'error'],
};

/**
 * `POST /:slug` responds with one JSON-RPC 2.0 message when the request body
 * was a single message, or an array of them (in order) when it was a batch.
 * A `tools/call` failure (unknown tool, or the tool's own handler throwing)
 * is carried as a JSON-RPC **result** with `isError: true` — see
 * `handleMcpMessage` — not as a JSON-RPC `error`; `error` is reserved for
 * protocol-level failures (unknown method, bad params).
 */
const McpJsonRpcResponse: JsonSchema = {
  description: 'A JSON-RPC 2.0 response, or an array of them for a batch request.',
  oneOf: [{ oneOf: [JsonRpcSuccess, JsonRpcFailure] }, { type: 'array', items: { oneOf: [JsonRpcSuccess, JsonRpcFailure] } }],
};

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
/**
 * The sign-in page needs a Content-Security-Policy of its own.
 *
 * The deployment-wide policy is `form-action 'self'`, and browsers enforce
 * `form-action` ACROSS THE REDIRECT that follows a submission. This page is
 * served by the API and its whole purpose is to redirect to the relying
 * party's `redirect_uri` on another origin — so the browser silently refused
 * the navigation. The server issued a correct 302 and nothing happened: no
 * error page, no console message except a CSP violation, and every headless
 * test passed because curl does not enforce CSP.
 *
 * `script-src 'self'` blocked the inline script that acknowledges a click, and
 * `img-src 'self' data:` blocked the Application's own logo, which is a remote
 * https URL. One header, three symptoms.
 *
 * The redirect origin is NOT taken from user input: `redirect_uri` has already
 * been matched against the client's registered allowlist by the time this runs,
 * so widening `form-action` to it grants nothing the flow did not already
 * permit. The nonce is per-response.
 */
function authorizePageCsp(redirectUri: string, nonce: string): string {
  let formAction = "'self'";
  try {
    formAction = `'self' ${new URL(redirectUri).origin}`;
  } catch {
    // Unparseable never reaches here — the route rejects it earlier — but a
    // policy that is too narrow is safer than one built from a bad value.
  }
  return [
    "default-src 'self'",
    "base-uri 'self'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    // The Application's logo is an operator-configured remote image.
    "img-src 'self' data: https:",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
  ].join('; ');
}

function renderAuthorizePage(opts: {
  actionUrl: string;
  appName: string;
  clientName: string;
  /**
   * The Application's own site, when the operator has set one. Used for the
   * password-reset link — without it this screen is a dead end for anyone who
   * has forgotten the password, which is the single most likely reason someone
   * is stuck here.
   */
  appUrl?: string | null;
  params: AuthorizeParams;
  /** The scopes that WILL be granted — already filtered by `grantScopes`. */
  grantedScopes: string[];
  error?: string;
  mfa?: boolean;
  /**
   * What was typed into the email field on a failed attempt, echoed back.
   *
   * The refusal is deliberately identical whether the password was wrong or no
   * such account exists — that is what stops this screen enumerating addresses.
   * The cost is that someone whose browser autofilled the wrong one of their
   * two addresses gets an error that cannot tell them so, retries, and sees the
   * same thing forever. Re-displaying their OWN input discloses nothing they
   * did not just type, and makes a substituted address visible immediately.
   */
  email?: string;
  /**
   * The Application's own branding, as configured on the Portal tab and already
   * served publicly by `GET /portal/config/:slug`. Reused here so an
   * Application's customers see that Application — its name, its mark, its
   * colour — rather than a generic form on whatever host the API happens to
   * run on.
   *
   * Read defensively: it is operator-authored JSON with no schema at rest, and
   * a malformed value must degrade to the plain screen, never break sign-in.
   */
  branding?: { displayName?: string; logoUrl?: string; primaryColor?: string } | null;
  /** Per-response CSP nonce for the one inline script this page carries. */
  nonce: string;
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
  // `logoUrl` is operator-authored and ends up in an <img src>. Only http(s)
  // survives — a `javascript:` or `data:` URL here would be script execution on
  // the sign-in page, which is the worst place in the product for it.
  const logo = (() => {
    const raw = opts.branding?.logoUrl;
    if (!raw) return '';
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return `<img class="logo" src="${esc(u.href)}" alt="">`;
    } catch {
      return '';
    }
  })();
  // Same reasoning for the colour: it lands inside a stylesheet, so anything
  // that is not a plain hex value is dropped rather than interpolated.
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(opts.branding?.primaryColor ?? '')
    ? opts.branding!.primaryColor!
    : '#0d9488';
  const shown = opts.branding?.displayName?.trim() || opts.appName;
  const reset = opts.appUrl
    ? `<p class="muted"><a href="${esc(opts.appUrl.replace(/\/+$/, ''))}/forgot-password">Forgot your password?</a></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ${esc(shown)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:#fafaf9;color:#1c1917}
@media(prefers-color-scheme:dark){body{background:#0c0a09;color:#fafaf9}}
.card{width:100%;max-width:24rem;background:#fff;border:1px solid #e7e5e4;border-radius:.75rem;padding:1.75rem}
@media(prefers-color-scheme:dark){.card{background:#1c1917;border-color:#292524}}
h1{font-size:1.125rem;line-height:1.4;margin:0 0 .25rem}
.logo{max-height:2rem;max-width:9rem;display:block;margin:0 0 1rem}
.who{font-size:.8125rem;color:#78716c;margin:0 0 1.25rem}
.grants{margin:0 0 1.25rem;padding:.75rem .875rem;border-radius:.5rem;background:#f5f5f4;font-size:.8125rem;color:#57534e}
@media(prefers-color-scheme:dark){.grants{background:#292524;color:#a8a29e}.who{color:#a8a29e}}
.grants p{margin:0 0 .375rem;font-weight:500}
.grants ul{margin:0;padding-left:1.125rem}
.grants li{margin:.125rem 0}
label{display:block;margin:.875rem 0 .3125rem;font-size:.8125rem;font-weight:500}
input{width:100%;padding:.5rem .625rem;border:1px solid #d6d3d1;border-radius:.375rem;font-size:.9375rem;background:transparent;color:inherit}
@media(prefers-color-scheme:dark){input{border-color:#44403c}}
input:focus{outline:2px solid ${accent};outline-offset:-1px;border-color:transparent}
.row{display:flex;gap:.5rem;margin-top:1.25rem}
button{flex:1;padding:.5625rem 1rem;border-radius:.375rem;border:0;cursor:pointer;font-size:.875rem;font-weight:500}
.allow{background:${accent};color:#fff}
.allow:hover{filter:brightness(.92)}
.deny{background:transparent;border:1px solid #d6d3d1;color:inherit}
@media(prefers-color-scheme:dark){.deny{border-color:#44403c}}
.err{margin:.75rem 0 0;padding:.5rem .625rem;border-radius:.375rem;background:#fef2f2;color:#b91c1c;font-size:.8125rem}
@media(prefers-color-scheme:dark){.err{background:#450a0a;color:#fca5a5}}
.muted{font-size:.75rem;color:#78716c;margin:1rem 0 0;text-align:center}
@media(prefers-color-scheme:dark){.muted{color:#a8a29e}}
.muted a{color:inherit}
</style>
</head><body>
  <main class="card">
    ${logo}
    <h1>Sign in to ${esc(shown)}</h1>
    <!-- Naming the client AND the account is the whole job of this line. The
         previous wording ("X wants to access your Y account") left people
         entering the wrong credentials, because on a deployment that runs its
         own panel the reader assumes it means their operator login. It does
         not: this is the end-user account for this Application. -->
    <p class="who">${esc(opts.clientName)} is asking for access. Use your ${esc(shown)} account — the one you sign in to ${esc(shown)} with, not an administrator login.</p>
    <div class="grants">
      <p>It will be able to:</p>
      <ul>${grants}</ul>
    </div>
    ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
    <form method="post" action="${esc(opts.actionUrl)}">
      ${hidden}
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="username" autofocus value="${esc(opts.email ?? '')}">
      <label for="password">Password</label>
      <input id="password" type="password" name="password" required autocomplete="current-password">
      ${opts.mfa ? '<label for="mfaCode">Authenticator code</label><input id="mfaCode" type="text" name="mfaCode" inputmode="numeric" autocomplete="one-time-code">' : ''}
      <div class="row">
        <button class="allow" type="submit" name="consent" value="allow">Allow</button>
        <button class="deny" type="submit" name="consent" value="deny">Deny</button>
      </div>
    </form>
    <!-- The form works without this. It is a plain POST and always has been —
         which is why the page must not depend on script to submit. All this
         adds is the acknowledgement a click deserves: the pressed button says
         what it is doing and both are disabled, so a slow round-trip does not
         look like a dead page and cannot be double-submitted into a second
         authorization code. -->
    <script nonce="${esc(opts.nonce)}">
      (function () {
        var form = document.currentScript.previousElementSibling;
        if (!form || form.tagName !== 'FORM') return;
        form.addEventListener('submit', function (e) {
          var pressed = e.submitter;
          var buttons = form.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            if (buttons[i] === pressed) {
              buttons[i].textContent =
                pressed.value === 'allow' ? 'Signing in\u2026' : 'Cancelling\u2026';
            }
            // Disabled AFTER the value is read for submission — disabling a
            // submitter before the browser serialises the form drops its
            // name/value, and the consent value is what this page decides.
            setTimeout(function (b) {
              return function () {
                b.disabled = true;
              };
            }(buttons[i]), 0);
          }
        });
      })();
    </script>
    ${reset}
  </main>
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
        response: {
          200: { description: 'Protected-resource metadata.', ...ProtectedResourceMetadata },
          ...errs(MCP_GATE_404),
        },
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
        response: {
          200: { description: 'Authorization-server metadata.', ...ref('OAuthAuthServerMetadata') },
          ...errs(AUTH_SERVER_GATE_404),
        },
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
        response: {
          200: { description: 'OpenID Provider metadata.', ...OpenIdConfiguration },
          ...errs(OIDC_GATE_404),
        },
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
        response: {
          201: { description: 'The registered public client.', ...ClientRegistrationResponse },
          ...errs({
            400:
              'INVALID_REDIRECT_URI — a `redirect_uris` entry is not an https URL, an http(s) ' +
              'loopback URL, or a well-formed custom scheme; or VALIDATION_ERROR — the body ' +
              'failed schema validation.',
            403: 'CLIENT_REGISTRATION_DISABLED — the operator has turned off dynamic client registration.',
            ...AUTH_SERVER_GATE_404,
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
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
        response: {
          200: raw('The login + consent HTML page.', 'text/html'),
          302: {
            description:
              'The authorization request could not be satisfied (unsupported `response_type`, ' +
              '`code_challenge_method` other than S256, `invalid_scope`, or an unsupported ' +
              '`prompt`/`request`/`request_uri`) — redirect to the client `redirect_uri` with ' +
              '`error` (+ `state`).',
          },
          400: raw(
            'Invalid authorization request, or unknown `client_id` / unregistered `redirect_uri` ' +
              '— rendered as an HTML error page, not JSON (there is no validated redirect target ' +
              'to bounce the browser to yet).',
            'text/html',
          ),
          ...errs(AUTH_SERVER_GATE_404),
        },
      },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const pageNonce = randomBytes(16).toString('base64');
      const application = await resolveAuthServerApp(slug);
      const q = AuthorizeQuery.safeParse(req.query);
      if (!q.success) {
        return reply.type('text/html').code(400).send('<p>Invalid authorization request.</p>');
      }
      const client = await mcpOAuthService.getClient(application.id, q.data.client_id);
      // Never redirect to an unvalidated URI — render an error instead.
      if (!client || !client.redirectUris.includes(q.data.redirect_uri)) {
        return reply.type('text/html').code(400).send('<p>Unknown client_id or unregistered redirect_uri.</p>');
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
      return reply
        .header('content-security-policy', authorizePageCsp(q.data.redirect_uri, pageNonce))
        .type('text/html')
        .send(
        renderAuthorizePage({
          nonce: pageNonce,
          actionUrl: `/api/v1/mcp/${slug}/oauth/authorize`,
          appName: application.name,
          appUrl: (application.authConfig as { appUrl?: string } | null)?.appUrl ?? null,
          branding: (application.portalBranding ?? null) as
            | { displayName?: string; logoUrl?: string; primaryColor?: string }
            | null,
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
        response: {
          200: raw(
            'Consent was allowed but sign-in failed (bad credentials, MFA code required/wrong, ' +
              'or MFA enrollment required) — the form is re-rendered with an inline error.',
            'text/html',
          ),
          302: {
            description:
              'Success — redirect to the client `redirect_uri` with `code` (+ `state`). Also ' +
              'used for the unsupported-request / `invalid_scope` / `access_denied` (consent ' +
              'was NOT "allow") cases, which redirect with `error` (+ `state`) instead.',
          },
          400: raw(
            'Invalid authorization request, or unknown `client_id` / unregistered `redirect_uri` ' +
              '— rendered as an HTML error page, not JSON.',
            'text/html',
          ),
          ...errs({
            ...AUTH_SERVER_GATE_404,
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
        },
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
      const pageNonce = randomBytes(16).toString('base64');
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

      const email = typeof body.email === 'string' ? body.email : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const mfaCode = typeof body.mfaCode === 'string' ? body.mfaCode : '';
      const renderErr = (error: string, mfa = false): unknown =>
        reply
          .header('content-security-policy', authorizePageCsp(params.redirect_uri, pageNonce))
          .type('text/html')
          .code(200)
          .send(
          renderAuthorizePage({
            nonce: pageNonce,
            actionUrl: `/api/v1/mcp/${slug}/oauth/authorize`,
            appName: application.name,
            clientName: client.clientName ?? 'An application',
            params,
            grantedScopes: granted.split(' '),
            error,
            mfa,
            email,
          }),
        );

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

  // ---- App-authorised session handoff ------------------------------------
  //
  // The interactive `/oauth/authorize` above authenticates the end-user with a
  // password form, because this AS has no SSO session to reuse. That is the
  // right answer for a third-party RP and the wrong one for an Application's
  // OWN server, which already holds a live session for the user it is asking
  // about: it would be re-prompting for a password it just accepted.
  //
  // This endpoint is that case. The Application's server presents its secret
  // key AND the user's live access token, and receives an authorization code
  // for one of its own registered clients. It grants NO authority the caller
  // did not already have — a secret key can already act across its
  // Application's end-users, and the access token proves this particular user
  // is authenticated right now, so the token cannot be used to target someone
  // who has not signed in. What it adds is packaging: a standards-shaped code
  // instead of a bespoke handoff.
  //
  // Deliberately NOT reachable with a publishable key. That WOULD be an
  // escalation — the publishable key is identity, not authorization, and it
  // lives in browsers. `requireApiKey` refuses anything without a secret
  // prefix before the handler runs; the check inside is defence in depth.
  //
  // Everything else is the same path the interactive flow takes: same
  // `createAuthCode`, so the code is single-use, 60-second, and PKCE-bound,
  // and the same `grantScopes` filter, so a scope the Application does not
  // support cannot be widened into the code.
  app.post(
    '/:slug/oauth/authorize/grant',
    {
      preHandler: [requireApiKey, requireUserSession, refuseWhileImpersonating('hand off a session')],
      config: { rateLimit: authRateLimit(30) },
      schema: {
        tags: ['MCP · OAuth'],
        summary: 'Exchange a live end-user session for an authorization code',
        description:
          "The Application's own server authorises a sign-in it has already performed. Requires " +
          'BOTH the Application secret key (`Authorization: Bearer rp_live_…`) and the ' +
          "end-user's live access token (`X-Rekey-User-Token`), which must belong to the same " +
          'Application. Returns a single-use, PKCE-bound authorization code to redeem at ' +
          '`/oauth/token` exactly like one from the interactive endpoint.',
        body: {
          type: 'object',
          required: ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method'],
          properties: {
            client_id: { type: 'string' },
            redirect_uri: { type: 'string' },
            code_challenge: { type: 'string' },
            code_challenge_method: { type: 'string', enum: ['S256'] },
            scope: { type: 'string' },
            nonce: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'The authorization code.',
            type: 'object',
            properties: {
              code: { type: 'string' },
              expires_in: { type: 'integer' },
            },
            required: ['code', 'expires_in'],
          },
          ...errs({
            ...AUTH_SERVER_GATE_404,
            400: 'INVALID_GRANT_REQUEST — unknown `client_id`, unregistered `redirect_uri`, non-S256 PKCE, or no grantable scope.',
            401: 'API_KEY_MISSING / API_KEY_INVALID / USER_TOKEN_MISSING / USER_TOKEN_INVALID / USER_TOKEN_WRONG_APPLICATION.',
            403: 'SESSION_HANDOFF_FORBIDDEN — the secret key belongs to a different Application than `:slug`, or the session is impersonated.',
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await resolveAuthServerApp(slug);

      // Defence in depth. `requireApiKey` already refuses a publishable key
      // (wrong prefix → API_KEY_INVALID), so this is unreachable — which is
      // why it can carry a specific code without becoming a probing oracle.
      if (req.authKind === 'publishable') {
        throw new RekeyError({
          statusCode: 403,
          code: 'SESSION_HANDOFF_FORBIDDEN',
          message: 'A publishable key cannot hand off a session.',
          fix: 'Call this from your server with the Application secret key.',
        });
      }

      // The slug names one Application and the secret key resolves to another
      // — refuse rather than letting a key for app A mint codes on app B.
      // `requireUserSession` has already bound the user token to the KEY's
      // Application, so without this the code would be minted on the wrong one.
      if (!req.application || req.application.id !== application.id) {
        throw new RekeyError({
          statusCode: 403,
          code: 'SESSION_HANDOFF_FORBIDDEN',
          message: 'The presented secret key belongs to a different Application.',
          fix: `Use the secret key for the Application "${slug}".`,
        });
      }

      const endUser = req.endUser;
      if (!endUser) {
        // Programming error — requireUserSession guarantees this.
        throw new RekeyError({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Session handoff ran without a resolved end-user.',
          fix: 'Register requireUserSession before this handler.',
        });
      }

      const body = GrantBody.parse(req.body ?? {});

      const client = await mcpOAuthService.getClient(application.id, body.client_id);
      if (!client || !client.redirectUris.includes(body.redirect_uri)) {
        throw new RekeyError({
          statusCode: 400,
          code: 'INVALID_GRANT_REQUEST',
          message: 'Unknown client_id, or the redirect_uri is not registered for it.',
          fix: 'Register the client and its exact redirect URI at POST /oauth/register.',
        });
      }
      if (body.code_challenge_method !== 'S256') {
        throw new RekeyError({
          statusCode: 400,
          code: 'INVALID_GRANT_REQUEST',
          message: 'code_challenge_method must be S256.',
          fix: 'Send base64url(sha256(code_verifier)) as `code_challenge` with method S256.',
        });
      }
      const granted = grantScopes(application, body.scope);
      if (granted === '') {
        throw new RekeyError({
          statusCode: 400,
          code: 'INVALID_GRANT_REQUEST',
          message: 'None of the requested scopes can be granted by this Application.',
          fix: 'Request scopes this Application supports (e.g. `openid email`).',
        });
      }

      const code = await mcpOAuthService.createAuthCode({
        applicationId: application.id,
        clientId: client.id,
        endUserId: endUser.id,
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        scope: granted,
        nonce: body.nonce,
        // The authentication this code attests to is the one that minted the
        // access token presented above, not this call. We do not know when
        // that happened, so `auth_time` is the moment we last SAW proof of it
        // — honest, and never later than the real event by more than the
        // token's lifetime.
        authTime: new Date(),
      });

      // Audited on purpose: this is the one path where a session appears
      // without an interactive sign-in behind it, so a stolen secret key must
      // leave a trail naming the Application, the user and the client.
      const { ip, userAgent } = requestContext(req);
      void recordSecurityEvent({
        type: 'user.session_handoff_granted',
        actorType: 'end_user',
        actorId: endUser.id,
        applicationId: application.id,
        ip,
        userAgent,
        metadata: { clientId: client.id, scope: granted },
      });

      return reply.send({ code, expires_in: 60 });
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
        response: {
          200: { description: 'Tokens issued.', ...TokenResponse },
          400: oauthError(
            'invalid_request — a required parameter is missing; invalid_grant — the code/PKCE ' +
              'verifier/refresh_token is invalid, expired, already used, erased, or not valid for ' +
              'this client; or unsupported_grant_type — `grant_type` is neither ' +
              '`authorization_code` nor `refresh_token`.',
          ),
          401: oauthError('invalid_client — unknown `client_id`.'),
          500: {
            description: 'server_error — an unexpected failure. Logged; `error_description` is omitted.',
            type: 'object',
            properties: { error: { type: 'string', enum: ['server_error'] } },
            required: ['error'],
          },
          ...errs({
            ...AUTH_SERVER_GATE_404,
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
        },
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
          // `err.status` is typed as a plain `number` (see OAuthError in oauth.service.ts);
          // the schema.response literals below narrow reply.code()'s accepted values, so
          // narrow here too. Every throw site in this file uses 400 or 401.
          return reply
            .code(err.status as 400 | 401)
            .send({ error: err.error, error_description: err.errorDescription });
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
        response: {
          200: { description: 'Token state (RFC 7662).', ...ref('OAuthIntrospectionResponse') },
          401: oauthError(
            "invalid_client — the Authorization header is missing this Application's secret key, " +
              'or the key belongs to a different Application.',
          ),
          ...errs({
            ...AUTH_SERVER_GATE_404,
            429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
          }),
        },
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
        response: {
          200: { description: 'Identity claims.', ...UserInfoClaims },
          401: oauthError(
            'invalid_token — the bearer token is missing, malformed, expired, revoked ' +
              '(token generation bumped), issued by a different Application, or its subject ' +
              'has been erased or (with `requireEmailVerification`) is unverified.',
          ),
          403: oauthError('insufficient_scope — the access token was not granted the `openid` scope.'),
          ...errs(OIDC_GATE_404),
        },
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
        response: {
          200: { description: 'JSON-RPC response(s).', ...McpJsonRpcResponse },
          202: {
            description:
              'The request body contained only JSON-RPC notifications (no `id`) — accepted, no reply body.',
          },
          401: oauthError(
            'invalid_token — the bearer token is missing, malformed, expired, revoked (token ' +
              'generation bumped), issued for a different Application, or its end-user has ' +
              'since been erased or (with `requireEmailVerification`) is unverified.',
          ),
          403: oauthError(
            'insufficient_scope — the access token is valid but was not granted the `mcp:account` ' +
              'scope (e.g. an OIDC sign-in-only token).',
          ),
          ...errs(MCP_GATE_404),
        },
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
        response: {
          405: oauthError('method_not_allowed — use POST for MCP JSON-RPC.'),
          ...errs(MCP_GATE_404),
        },
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
