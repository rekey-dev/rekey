/**
 * Per-Application OAuth 2.1 authorization server.
 *
 * Rekey acts as the AS that clients authenticate an Application's end-users
 * against. It fronts two resources, each gated by its own `authConfig` toggle:
 *
 *   - `mcpEnabled`  — the hosted MCP server at `/api/v1/mcp/<slug>`, reached
 *                     with the `mcp:account` scope.
 *   - `oidcEnabled` — the Application as an OpenID Provider: `openid` grants an
 *                     ID Token and access to `/oauth/userinfo` (oidc.service.ts).
 *
 * The grant is the same either way — one client registry, one authorization
 * code, one token endpoint — so a client can hold both, and neither surface can
 * be reached with the other's scope. Standards:
 *   - RFC 8414  authorization-server metadata
 *   - RFC 9728  protected-resource metadata
 *   - RFC 7591  dynamic client registration (public clients, PKCE)
 *   - RFC 7636  PKCE (S256 only)
 *   - OIDC Core 1.0 + Discovery 1.0 (see oidc.service.ts)
 *
 * With BOTH toggles off the whole surface 404s.
 */

import type { Application, EndUser } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { env } from '../../config/env.js';
import { issueMcpAccessToken, verifyMcpAccessToken, type McpAccessClaims } from '../../lib/jwt.js';
import {
  issueRefreshToken,
  lookupRefreshToken,
  rotateRefreshToken,
} from '../../lib/refresh-tokens.js';
import {
  OIDC_SCOPES_SUPPORTED,
  OPENID_SCOPE,
  PROFILE_SCOPE,
  EMAIL_SCOPE,
  hasScope,
  identityClaims,
  issueIdTokenForGrant,
  oidcDiscoveryDocument,
  scopeSet,
} from './oidc.service.js';

/** Read access to the end-user's own account through the hosted MCP server. */
export const MCP_SCOPE = 'mcp:account';

const AUTH_CODE_TTL_MS = 60 * 1000; // 60s, single-use.

/**
 * OAuth error (RFC 6749 §5.2). Carried distinctly from RekeyError because the
 * token endpoint must emit the `{ error, error_description }` shape OAuth
 * clients parse — not the Rekey envelope.
 */
export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly errorDescription: string,
    public readonly status = 400,
  ) {
    super(errorDescription);
    this.name = 'OAuthError';
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function base64urlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Externally-reachable base origin for issuer/endpoint URLs in metadata. */
function publicBase(): string {
  return (env.PUBLIC_WEBHOOK_BASE_URL ?? env.API_URL).replace(/\/$/, '');
}

/**
 * The Application's authorization-server URL. It is simultaneously the MCP
 * resource URL, the OAuth issuer and — when `oidcEnabled` — the OIDC `iss`.
 * The `/api/v1/mcp` path is historic (MCP got here first) and is now load-
 * bearing: it is baked into registered clients, live tokens' `aud`, and the
 * discovery documents third parties have already fetched. One AS, one issuer.
 */
export function mcpIssuer(slug: string): string {
  return `${publicBase()}/api/v1/mcp/${slug}`;
}

/** Deployment-wide JWKS. ID Tokens are verified against this and nothing else. */
function jwksUri(): string {
  return `${publicBase()}/.well-known/jwks.json`;
}

/**
 * Resolve an Application by slug, asserting the caller's surface is switched on.
 * Throws 404 when the app is missing OR the toggle is off — we don't disclose
 * which, so a disabled app is indistinguishable from a missing one.
 */
async function resolveApp(
  slug: string,
  wanted: 'mcp' | 'oidc' | 'either',
): Promise<Application> {
  const app = await prisma.application.findUnique({ where: { slug } });
  const cfg = app ? AuthConfigSchema.parse(app.authConfig) : null;
  const enabled =
    cfg === null
      ? false
      : wanted === 'mcp'
        ? cfg.mcpEnabled
        : wanted === 'oidc'
          ? cfg.oidcEnabled
          : cfg.mcpEnabled || cfg.oidcEnabled;
  if (!app || !enabled) {
    // OIDC-only surfaces get their own code: an operator who hit /userinfo on
    // an Application that never enabled OIDC is not helped by being told about
    // MCP. The shared endpoints keep MCP_NOT_FOUND — clients and docs have been
    // reading that code since before OIDC existed.
    if (wanted === 'oidc') {
      throw new RekeyError({
        statusCode: 404,
        code: 'OIDC_NOT_FOUND',
        message: 'No OpenID Provider is available at this path.',
        fix: 'Enable OIDC for the Application (authConfig.oidcEnabled = true), and check the slug.',
      });
    }
    throw new RekeyError({
      statusCode: 404,
      code: 'MCP_NOT_FOUND',
      message: 'No MCP server is available at this path.',
      fix: 'Enable MCP for the Application (authConfig.mcpEnabled = true) via the panel, and check the slug.',
    });
  }
  return app;
}

/** MCP-only surfaces: the JSON-RPC endpoint and its RFC 9728 metadata. */
export async function resolveMcpApp(slug: string): Promise<Application> {
  return resolveApp(slug, 'mcp');
}

/** OIDC-only surfaces: `/.well-known/openid-configuration` and `/oauth/userinfo`. */
export async function resolveOidcApp(slug: string): Promise<Application> {
  return resolveApp(slug, 'oidc');
}

/**
 * The shared grant endpoints — authorize, token, register, introspect, and the
 * RFC 8414 metadata that describes them. Either toggle mounts them; which
 * scopes they will actually grant still depends on the individual toggles
 * (`supportedScopes`).
 */
export async function resolveAuthServerApp(slug: string): Promise<Application> {
  return resolveApp(slug, 'either');
}

/**
 * Every scope this Application's AS will grant, in metadata-advertised order.
 * Driven by the toggles, so the advertised list is exactly the grantable one —
 * a client can never read `openid` out of the metadata of an Application that
 * would refuse to grant it.
 *
 * `email` carries an extra condition: `authConfig.requireEmailVerification`.
 * An `id_token` saying `"email":"ceo@bigcorp.example"` for an address nobody
 * ever proved is an account-takeover primitive at any relying party that keys
 * on the claim, and RPs routinely ignore `email_verified`. Rather than emit a
 * claim we cannot stand behind, an Application that does not require verified
 * addresses simply does not offer the scope — and says so in discovery, since
 * this same function feeds `scopes_supported`.
 */
export function supportedScopes(application: Application): string[] {
  const cfg = AuthConfigSchema.parse(application.authConfig);
  const scopes: string[] = [];
  if (cfg.oidcEnabled) {
    scopes.push(
      ...OIDC_SCOPES_SUPPORTED.filter((s) => s !== EMAIL_SCOPE || cfg.requireEmailVerification),
    );
  }
  if (cfg.mcpEnabled) scopes.push(MCP_SCOPE);
  return scopes;
}

/** Is RFC 7591 open registration switched on for this Application? */
export function registrationOpen(application: Application): boolean {
  return AuthConfigSchema.parse(application.authConfig).dynamicClientRegistration;
}

/**
 * Resolve the scopes actually granted from a client's `scope` request.
 *
 * Requested ∩ supported, in supported order, deduped. Unrecognised values are
 * dropped silently (RFC 6749 §3.3 lets the AS ignore part of the request) —
 * a client cannot talk itself into a scope this AS does not define, or into one
 * the operator has switched off.
 *
 * Two shaping rules on top of the intersection:
 *   - `profile` / `email` survive only alongside `openid`. They are OIDC scopes
 *     whose claims are reachable exclusively through `/userinfo` and the ID
 *     Token, both of which demand `openid`; granting them alone would put a
 *     scope on a token that unlocks nothing.
 *   - A request that names NO scope at all falls back to `mcp:account` when MCP
 *     is on, preserving the pre-OIDC behaviour for MCP clients that send no
 *     `scope` parameter. With MCP off there is nothing safe to assume, so the
 *     caller gets `''` and turns it into `invalid_scope`.
 *
 * The fallback is deliberately keyed on "the client asked for nothing", not on
 * "nothing survived the intersection". Those were the same condition until OIDC
 * arrived, and conflating them meant an Application with MCP on and OIDC off
 * answered `scope=openid` — a request to sign someone in — with a working
 * `mcp:account` token that reached `tools/list`. An operator who deliberately
 * left OIDC off does not thereby consent to handing account-read access to
 * anything that asks for sign-in, and `scope=admin root` is not a request for
 * anything either. A non-empty request this AS cannot satisfy is an error.
 */
export function grantScopes(application: Application, requested: string | undefined): string {
  const asked = scopeSet(requested);
  const supported = supportedScopes(application);
  let granted = supported.filter((s) => asked.has(s));
  if (!granted.includes(OPENID_SCOPE)) {
    granted = granted.filter((s) => s !== PROFILE_SCOPE && s !== EMAIL_SCOPE);
  }
  if (granted.length === 0) {
    if (asked.size > 0) return '';
    return supported.includes(MCP_SCOPE) ? MCP_SCOPE : '';
  }
  return granted.join(' ');
}

export function authServerMetadata(application: Application): Record<string, unknown> {
  const issuer = mcpIssuer(application.slug);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    // Omitted, not advertised-and-broken, when the operator has closed
    // registration: RFC 8414 makes the member optional precisely so a client
    // can tell "register here" from "do not try".
    ...(registrationOpen(application) && {
      registration_endpoint: `${issuer}/oauth/register`,
    }),
    introspection_endpoint: `${issuer}/oauth/introspect`,
    scopes_supported: supportedScopes(application),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // PKCE is mandatory; only S256 is accepted (never `plain`).
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/**
 * OpenID Provider Metadata for an Application. A superset of the RFC 8414
 * document above (same issuer, same endpoints) plus the OIDC-specific fields —
 * `userinfo_endpoint`, `jwks_uri`, `id_token_signing_alg_values_supported`.
 */
export function openidConfiguration(application: Application): Record<string, unknown> {
  const issuer = mcpIssuer(application.slug);
  return oidcDiscoveryDocument({
    issuer,
    jwksUri: jwksUri(),
    scopesSupported: supportedScopes(application),
    ...(registrationOpen(application) && {
      registrationEndpoint: `${issuer}/oauth/register`,
    }),
  });
}

export function protectedResourceMetadata(slug: string): Record<string, unknown> {
  const issuer = mcpIssuer(slug);
  return {
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: ['mcp:account'],
    bearer_methods_supported: ['header'],
  };
}

export interface RegisterClientInput {
  redirectUris: string[];
  clientName?: string | undefined;
}

// Schemes that are never valid OAuth redirect targets — reject even though
// they parse as a "custom scheme".
const DENIED_REDIRECT_SCHEMES = new Set([
  'ftp:',
  'file:',
  'data:',
  'javascript:',
  'vbscript:',
  'gopher:',
  'ws:',
  'wss:',
  'mailto:',
  'tel:',
  'blob:',
]);

/** A redirect URI is acceptable if it's an https URL, an http loopback URL, or
 * a custom app scheme (claude://, cursor://, …) — the shapes MCP clients use.
 * Non-loopback http and known-dangerous schemes are rejected. */
function isAcceptableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (DENIED_REDIRECT_SCHEMES.has(u.protocol.toLowerCase())) return false;
  // Custom app scheme — must be a well-formed scheme token.
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol);
}

/**
 * The GDPR erasure gate for this surface — the OAuth/OIDC counterpart of
 * `assertEndUserNotErased` in modules/auth/auth.service.ts.
 *
 * It is a second implementation rather than a call to that one because the two
 * speak different error dialects: the session API answers `410 END_USER_ERASED`
 * in the Rekey envelope, and the token endpoint MUST answer
 * `{ error, error_description }` (RFC 6749 §5.2) or clients cannot parse it.
 * The RULE is identical and must stay identical — a tombstoned end-user has had
 * their credentials hard-deleted and can never authenticate again, whichever
 * door is tried.
 *
 * Returns `null` rather than throwing so `/userinfo` and the MCP endpoint can
 * phrase their own RFC 6750 challenges; `requireLiveGrantSubject` is the
 * throwing form the grants use.
 */
async function liveGrantSubject(
  applicationId: string,
  endUserId: string,
): Promise<EndUser | null> {
  const user = await prisma.endUser.findFirst({ where: { id: endUserId, applicationId } });
  // An erased end-user is a tombstone: `email` is a synthetic
  // `…@deleted.invalid` address and the profile is nulled. Serving that as
  // claims would be worse than serving nothing, and the account can no longer
  // authenticate anywhere else either — so every token naming it reads as
  // invalid.
  if (!user || user.erasedAt !== null) return null;
  return user;
}

async function requireLiveGrantSubject(
  applicationId: string,
  endUserId: string,
): Promise<EndUser> {
  const user = await liveGrantSubject(applicationId, endUserId);
  if (!user) {
    // `invalid_grant`, not `invalid_request`: the code / refresh token itself
    // was well-formed, and what stopped it is a property of the grant. The
    // description says nothing about erasure — a client cannot act on it and it
    // would answer "was this person deleted" for anyone holding a stale token.
    throw new OAuthError('invalid_grant', 'This grant is no longer valid for its subject.');
  }
  return user;
}

export const mcpOAuthService = {
  /**
   * Is the end-user a token names still live (not erased)? For the resource
   * servers, which answer with an RFC 6750 challenge rather than an OAuth
   * error body.
   */
  async grantSubjectIsLive(applicationId: string, endUserId: string): Promise<boolean> {
    return (await liveGrantSubject(applicationId, endUserId)) !== null;
  },

  /** RFC 7591 dynamic client registration. Public client (PKCE, no secret). */
  async registerClient(
    applicationId: string,
    input: RegisterClientInput,
  ): Promise<Record<string, unknown>> {
    const redirectUris = input.redirectUris.map((u) => u.trim()).filter(Boolean);
    if (redirectUris.length === 0 || redirectUris.length > 20) {
      throw new RekeyError({
        statusCode: 400,
        code: 'INVALID_REDIRECT_URI',
        message: 'redirect_uris must contain between 1 and 20 entries.',
        fix: 'Register at least one redirect URI (and no more than 20).',
      });
    }
    for (const uri of redirectUris) {
      if (!isAcceptableRedirectUri(uri)) {
        throw new RekeyError({
          statusCode: 400,
          code: 'INVALID_REDIRECT_URI',
          message: `redirect_uri "${uri}" is not acceptable.`,
          fix: 'Use an https URL, an http(s) loopback URL, or a custom-scheme URL.',
        });
      }
    }
    const client = await prisma.oAuthClient.create({
      data: {
        applicationId,
        clientName: input.clientName ?? null,
        redirectUris,
      },
    });
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.clientName ?? undefined,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },

  /** Load a registered client scoped to the Application; null if not found. */
  async getClient(
    applicationId: string,
    clientId: string,
  ): Promise<{ id: string; redirectUris: string[]; clientName: string | null } | null> {
    const client = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
    if (!client || client.applicationId !== applicationId) return null;
    return { id: client.id, redirectUris: client.redirectUris, clientName: client.clientName };
  },

  /**
   * Mint a single-use authorization code bound to the authenticated end-user,
   * the client, redirect_uri, PKCE challenge and scope. Returns the raw code
   * (stored hashed). 60-second TTL.
   *
   * `nonce` and `authTime` are the OIDC half: both belong to the authentication
   * that just happened, and both must reach the ID Token minted at redemption,
   * so the code row is where they live in between. Neither is ever read back
   * from the client.
   */
  async createAuthCode(args: {
    applicationId: string;
    clientId: string;
    endUserId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    nonce?: string | undefined;
    authTime: Date;
  }): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await prisma.oAuthAuthCode.create({
      data: {
        codeHash: sha256(raw),
        applicationId: args.applicationId,
        clientId: args.clientId,
        endUserId: args.endUserId,
        redirectUri: args.redirectUri,
        codeChallenge: args.codeChallenge,
        scope: args.scope,
        nonce: args.nonce ?? null,
        authTime: args.authTime,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      },
    });
    return raw;
  },

  /** authorization_code grant: validate + PKCE-verify + burn the code, issue tokens. */
  async exchangeCode(args: {
    application: Application;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
  }): Promise<Record<string, unknown>> {
    const row = await prisma.oAuthAuthCode.findUnique({ where: { codeHash: sha256(args.code) } });
    const invalid = (): never => {
      throw new OAuthError('invalid_grant', 'Authorization code is invalid, expired, or already used.');
    };
    if (
      !row ||
      row.applicationId !== args.application.id ||
      row.clientId !== args.clientId ||
      row.redirectUri !== args.redirectUri ||
      row.expiresAt <= new Date()
    ) {
      invalid();
    }
    // Atomic single-use claim — a replayed code loses the race.
    const claimed = await prisma.oAuthAuthCode.updateMany({
      where: { id: row!.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) invalid();
    // PKCE S256: base64url(sha256(verifier)) must equal the stored challenge.
    if (!constantTimeEqual(base64urlSha256(args.codeVerifier), row!.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    }
    // Erasure gate. Codes live 60 seconds, but erasure does not delete them
    // atomically with the request that redeems them, and a code minted before
    // an erasure was redeemable after it — yielding an `id_token` about a
    // person whose data we had just promised to destroy.
    const user = await requireLiveGrantSubject(args.application.id, row!.endUserId);
    return this.issueTokens(args.application, user, row!.scope, args.clientId, {
      nonce: row!.nonce ?? undefined,
      // Codes minted before `auth_time` existed have none. The authorize form
      // authenticates the user seconds before the code is redeemed, so the
      // row's own creation time is the authentication time for those.
      authTime: row!.authTime ?? row!.createdAt,
    });
  },

  /** refresh_token grant: rotate the refresh token, issue a fresh access token. */
  async refreshGrant(args: {
    application: Application;
    refreshToken: string;
    clientId: string;
    scope?: string | undefined;
  }): Promise<Record<string, unknown>> {
    const outcome = await lookupRefreshToken(args.refreshToken);
    if (outcome.kind !== 'ok' || outcome.token.applicationId !== args.application.id) {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid, expired, or revoked.');
    }
    // Only MCP-surface tokens bound to THIS client may refresh here — a session
    // refresh token (or another client's) is rejected.
    if (outcome.token.kind !== 'mcp' || outcome.token.clientId !== args.clientId) {
      throw new OAuthError('invalid_grant', 'Refresh token is not valid for this client.');
    }
    // Erasure gate, checked BEFORE the rotation so a refused refresh leaves the
    // chain exactly as it was. Erasure hard-deletes every refresh row for the
    // user, MCP-surface ones included, so this normally cannot fire — but the
    // window worth closing is not the 60 seconds of a code, it is the 30 days
    // of a refresh chain, and a token rotated by a concurrent request could
    // still land here.
    await requireLiveGrantSubject(args.application.id, outcome.token.endUserId);
    // The scope granted at consent, carried down the whole rotation chain. NOT
    // a constant: re-issuing `mcp:account` here would silently widen a grant
    // the end-user approved as `openid email` into MCP tool access. Null on
    // rows minted before the column existed — those could only ever have been
    // MCP grants, which is exactly what this used to hard-code.
    const scope = outcome.token.scope ?? MCP_SCOPE;
    let replacement;
    try {
      replacement = await rotateRefreshToken(outcome.token);
    } catch {
      throw new OAuthError('invalid_grant', 'Refresh token could not be rotated (possible reuse).');
    }
    const access = issueMcpAccessToken({
      endUserId: outcome.token.endUserId,
      applicationId: args.application.id,
      tokenGeneration: args.application.tokenGeneration,
      audience: mcpIssuer(args.application.slug),
      scope,
    });
    // Deliberately NO `id_token` here, though OIDC Core §12.2 permits one. A
    // refresh performs no authentication: the only honest `auth_time` would be
    // the original sign-in, and re-asserting it hours later reads to a relying
    // party as a fresh authentication event that never happened. Clients that
    // need a current assertion send the user back through /oauth/authorize.
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round((access.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: replacement.raw,
      scope,
    };
  },

  /**
   * Shared token-response builder for the authorization_code path.
   *
   * Takes the resolved `EndUser` rather than an id: the caller has already had
   * to load it to run the erasure gate, and re-reading here once meant the row
   * the ID Token described was not necessarily the row that passed the gate.
   */
  async issueTokens(
    application: Application,
    user: EndUser,
    scope: string,
    clientId: string,
    oidc?: { nonce?: string | undefined; authTime: Date },
  ): Promise<Record<string, unknown>> {
    const endUserId = user.id;
    const access = issueMcpAccessToken({
      endUserId,
      applicationId: application.id,
      tokenGeneration: application.tokenGeneration,
      audience: mcpIssuer(application.slug),
      scope,
    });
    // MCP-surface refresh token, bound to the OAuth client. Rejected at the
    // session /auth/refresh endpoint and only redeemable by the same client.
    // The granted scope rides along so the refresh grant can reproduce it
    // exactly instead of assuming.
    const refresh = await issueRefreshToken(application.id, endUserId, {
      kind: 'mcp',
      clientId,
      scope,
    });
    const response: Record<string, unknown> = {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round((access.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: refresh.raw,
      scope,
    };
    if (oidc && hasScope(scope, OPENID_SCOPE)) {
      const idToken = await issueIdTokenForGrant({
        issuer: mcpIssuer(application.slug),
        clientId,
        user,
        scope,
        authTime: oidc.authTime,
        nonce: oidc.nonce,
        accessToken: access.token,
      });
      response.id_token = idToken.token;
    }
    return response;
  },

  /**
   * Identity claims for a bearer access token, for `GET|POST /oauth/userinfo`.
   *
   * Returns null when the token is not a live `mcp_access` token for THIS
   * Application (wrong signature, wrong `aud`, expired, revoked generation) or
   * when its holder has since been erased. `insufficient_scope` — a valid token
   * that was never granted `openid` — is the caller's to raise, because RFC 6750
   * gives it a different status code than a bad token.
   */
  async userInfo(
    application: Application,
    token: string,
  ): Promise<
    | { ok: true; claims: Record<string, unknown> }
    | { ok: false; reason: 'invalid_token' | 'insufficient_scope' }
  > {
    const claims: McpAccessClaims | null = verifyMcpAccessToken(
      token,
      application.id,
      application.tokenGeneration,
      mcpIssuer(application.slug),
    );
    if (!claims) return { ok: false, reason: 'invalid_token' };
    if (!hasScope(claims.scope, OPENID_SCOPE)) return { ok: false, reason: 'insufficient_scope' };
    const user = await liveGrantSubject(application.id, claims.sub);
    if (!user) return { ok: false, reason: 'invalid_token' };
    return { ok: true, claims: identityClaims(user, claims.scope) };
  },

  /** RFC 7662 token introspection. Returns the active claims or `{ active:false }`. */
  introspect(application: Application, token: string): Record<string, unknown> {
    const claims: McpAccessClaims | null = verifyMcpAccessToken(
      token,
      application.id,
      application.tokenGeneration,
      mcpIssuer(application.slug),
    );
    if (!claims) return { active: false };
    return {
      active: true,
      sub: claims.sub,
      scope: claims.scope,
      aud: claims.aud,
      exp: claims.exp,
      iat: claims.iat,
      token_type: 'Bearer',
      client_id: undefined,
    };
  },
};
