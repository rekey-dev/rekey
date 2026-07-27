/**
 * Per-Application OAuth 2.1 authorization server for MCP.
 *
 * Rekey acts as the AS that MCP clients (Claude Code, Claude Desktop, …)
 * authenticate an Application's end-users against, then connect to the hosted
 * MCP server at `/api/v1/mcp/<slug>`. Standards:
 *   - RFC 8414  authorization-server metadata
 *   - RFC 9728  protected-resource metadata
 *   - RFC 7591  dynamic client registration (public clients, PKCE)
 *   - RFC 7636  PKCE (S256 only)
 *
 * Gated per-app by `authConfig.mcpEnabled`; while off the whole surface 404s.
 */

import type { Application } from '@prisma/client';
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

/** The only scope phase-1 grants — read access to the end-user's own account. */
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

/** The MCP resource URL == OAuth issuer for an app. */
export function mcpIssuer(slug: string): string {
  return `${publicBase()}/api/v1/mcp/${slug}`;
}

/**
 * Resolve an Application by slug and assert MCP is enabled. Throws 404
 * (MCP_NOT_FOUND) when the app is missing OR the toggle is off — we don't
 * disclose which, so a disabled app is indistinguishable from a missing one.
 */
export async function resolveMcpApp(slug: string): Promise<Application> {
  const app = await prisma.application.findUnique({ where: { slug } });
  if (!app || !AuthConfigSchema.parse(app.authConfig).mcpEnabled) {
    throw new RekeyError({
      statusCode: 404,
      code: 'MCP_NOT_FOUND',
      message: 'No MCP server is available at this path.',
      fix: 'Enable MCP for the Application (authConfig.mcpEnabled = true) via the panel, and check the slug.',
    });
  }
  return app;
}

export function authServerMetadata(slug: string): Record<string, unknown> {
  const issuer = mcpIssuer(slug);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    scopes_supported: ['mcp:account'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // PKCE is mandatory; only S256 is accepted (never `plain`).
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
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

export const mcpOAuthService = {
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
   */
  async createAuthCode(args: {
    applicationId: string;
    clientId: string;
    endUserId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
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
    return this.issueTokens(args.application, row!.endUserId, row!.scope, args.clientId);
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
      scope: MCP_SCOPE,
    });
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round((access.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: replacement.raw,
      scope: MCP_SCOPE,
    };
  },

  /** Shared token-response builder for the authorization_code path. */
  async issueTokens(
    application: Application,
    endUserId: string,
    scope: string,
    clientId: string,
  ): Promise<Record<string, unknown>> {
    const access = issueMcpAccessToken({
      endUserId,
      applicationId: application.id,
      tokenGeneration: application.tokenGeneration,
      audience: mcpIssuer(application.slug),
      scope,
    });
    // MCP-surface refresh token, bound to the OAuth client. Rejected at the
    // session /auth/refresh endpoint and only redeemable by the same client.
    const refresh = await issueRefreshToken(application.id, endUserId, {
      kind: 'mcp',
      clientId,
    });
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round((access.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: refresh.raw,
      scope,
    };
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
