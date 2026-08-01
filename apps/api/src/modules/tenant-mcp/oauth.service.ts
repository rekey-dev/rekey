/**
 * Operator MCP OAuth 2.1 authorization server.
 *
 * Mirrors the per-Application MCP OAuth shape (modules/mcp/oauth.service.ts)
 * but binds tokens to a (tenantUserId, tenantId) pair the operator picks at
 * the panel consent page. The operator authenticates through the REAL panel
 * login (modules/tenant-auth) — this service never checks a password. The
 * panel calls `POST /oauth/grant` once the operator is authenticated; the
 * only identity check here is `memberRole` (is this operator a member of the
 * chosen workspace?).
 *
 * Standards: RFC 8414 / RFC 9728 (metadata), RFC 7591 (dynamic registration),
 * RFC 6749 / RFC 7636 (authorization code + PKCE), RFC 7662 (introspection).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { env } from '../../config/env.js';
import {
  issueOperatorMcpAccessToken,
  verifyOperatorMcpAccessToken,
  type OperatorMcpAccessClaims,
} from '../../lib/operator-mcp-jwt.js';
import type { TenantRole } from '@prisma/client';

/** Read access across the operator's workspace. Always granted. */
export const OPERATOR_MCP_READ_SCOPE = 'mcp:operator:read';
/** Write access — create/edit applications, plans, webhook endpoints, auth-config. */
export const OPERATOR_MCP_WRITE_SCOPE = 'mcp:operator:write';
/**
 * Admin access — destructive / financial / secret-handling operations:
 * configuring provider credentials, cancelling subscriptions, (later) refunds
 * and deletes. Strictly above write so a client must request it explicitly and
 * the operator must approve it on the consent screen, separately from write.
 */
export const OPERATOR_MCP_ADMIN_SCOPE = 'mcp:operator:admin';
/**
 * Unused alias for the read scope — zero importers in this repo. Kept only so an
 * external consumer of the pre-tiering name doesn't break on upgrade; safe to
 * delete once 2.0.0 is out.
 */
export const OPERATOR_MCP_SCOPE = OPERATOR_MCP_READ_SCOPE;
/** Every scope this AS recognises, in metadata-advertised order. */
export const OPERATOR_MCP_SCOPES_SUPPORTED = [
  OPERATOR_MCP_READ_SCOPE,
  OPERATOR_MCP_WRITE_SCOPE,
  OPERATOR_MCP_ADMIN_SCOPE,
] as const;

/**
 * Resolve the scopes actually granted from a client's `scope` request.
 *
 * Read is always granted (the floor). Write and admin are granted only when
 * explicitly requested AND recognised. Admin IMPLIES write (an admin grant can
 * also do everything write can). Anything unrecognised is dropped silently — a
 * client can't talk itself into a scope this AS doesn't define. Returns a
 * normalised, deduped, space-separated string with read first.
 */
export function grantScopes(requested: string | undefined): string {
  const asked = new Set((requested ?? '').split(/\s+/).filter(Boolean));
  const granted = [OPERATOR_MCP_READ_SCOPE];
  const admin = asked.has(OPERATOR_MCP_ADMIN_SCOPE);
  if (admin || asked.has(OPERATOR_MCP_WRITE_SCOPE)) granted.push(OPERATOR_MCP_WRITE_SCOPE);
  if (admin) granted.push(OPERATOR_MCP_ADMIN_SCOPE);
  return granted.join(' ');
}

/** Does a granted-scope string carry write capability? */
export function scopeHasWrite(scope: string | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes(OPERATOR_MCP_WRITE_SCOPE);
}

/** Does a granted-scope string carry admin capability? */
export function scopeHasAdmin(scope: string | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes(OPERATOR_MCP_ADMIN_SCOPE);
}

const AUTH_CODE_TTL_MS = 60 * 1000; // 60s, single-use
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/**
 * OAuth error (RFC 6749 §5.2). Carried distinctly from RekeyError because
 * the token endpoint must emit the `{ error, error_description }` shape OAuth
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

function sha256Hex(input: string): string {
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

function publicBase(): string {
  return (env.PUBLIC_WEBHOOK_BASE_URL ?? env.API_URL).replace(/\/$/, '');
}

/** The operator MCP resource URL == OAuth issuer. */
export function operatorMcpIssuer(): string {
  return `${publicBase()}/api/v1/tenant/mcp`;
}

export function operatorAuthServerMetadata(): Record<string, unknown> {
  const issuer = operatorMcpIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    scopes_supported: [...OPERATOR_MCP_SCOPES_SUPPORTED],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

export function operatorProtectedResourceMetadata(): Record<string, unknown> {
  const issuer = operatorMcpIssuer();
  return {
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: [...OPERATOR_MCP_SCOPES_SUPPORTED],
    bearer_methods_supported: ['header'],
  };
}

// --- Redirect-URI allowlist (mirrors per-app MCP) ---

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
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol);
}

export interface RegisterClientInput {
  redirectUris: string[];
  clientName?: string | undefined;
}

export const operatorMcpOAuthService = {
  /** RFC 7591 dynamic client registration. Public client (PKCE, no secret). */
  async registerClient(input: RegisterClientInput): Promise<Record<string, unknown>> {
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
    const client = await prisma.tenantOAuthClient.create({
      data: {
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

  async getClient(
    clientId: string,
  ): Promise<{ id: string; redirectUris: string[]; clientName: string | null } | null> {
    const client = await prisma.tenantOAuthClient.findUnique({ where: { id: clientId } });
    if (!client) return null;
    return { id: client.id, redirectUris: client.redirectUris, clientName: client.clientName };
  },

  /**
   * The operator's role in a workspace, or null if they aren't a member.
   *
   * This is the ONLY identity check the grant path makes: the panel has
   * already authenticated the operator (full login — MFA + lockout) and
   * `requireTenantSession` proved who they are; here we confirm they actually
   * belong to the workspace they're consenting for. Re-read live so a revoked
   * membership can't be consented to.
   */
  async memberRole(tenantUserId: string, tenantId: string): Promise<TenantRole | null> {
    const membership = await prisma.tenantMembership.findUnique({
      where: { tenantUserId_tenantId: { tenantUserId, tenantId } },
    });
    return membership?.role ?? null;
  },

  /**
   * Mint a single-use authorization code bound to (client, tenantUser,
   * tenantId, redirect_uri, PKCE challenge, scope). 60-second TTL. Returns
   * the raw code (stored hashed).
   */
  async createAuthCode(args: {
    clientId: string;
    tenantUserId: string;
    tenantId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
  }): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await prisma.tenantOAuthAuthCode.create({
      data: {
        codeHash: sha256Hex(raw),
        clientId: args.clientId,
        tenantUserId: args.tenantUserId,
        tenantId: args.tenantId,
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
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    userAgent?: string | undefined;
    ip?: string | undefined;
  }): Promise<Record<string, unknown>> {
    const row = await prisma.tenantOAuthAuthCode.findUnique({
      where: { codeHash: sha256Hex(args.code) },
    });
    const invalid = (): never => {
      throw new OAuthError('invalid_grant', 'Authorization code is invalid, expired, or already used.');
    };
    if (
      !row ||
      row.clientId !== args.clientId ||
      row.redirectUri !== args.redirectUri ||
      row.expiresAt <= new Date()
    ) {
      invalid();
    }
    // Atomic single-use claim — a replayed code loses the race.
    const claimed = await prisma.tenantOAuthAuthCode.updateMany({
      where: { id: row!.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) invalid();
    // PKCE S256: base64url(sha256(verifier)) must equal stored challenge.
    if (!constantTimeEqual(base64urlSha256(args.codeVerifier), row!.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    }
    // Re-confirm the operator is still a workspace member at exchange time.
    const membership = await prisma.tenantMembership.findUnique({
      where: {
        tenantUserId_tenantId: { tenantUserId: row!.tenantUserId, tenantId: row!.tenantId },
      },
    });
    if (!membership) {
      throw new OAuthError(
        'invalid_grant',
        'Operator is no longer a member of the workspace this code was minted for.',
      );
    }
    return this.issueTokens({
      tenantUserId: row!.tenantUserId,
      tenantId: row!.tenantId,
      clientId: args.clientId,
      scope: row!.scope,
      userAgent: args.userAgent,
      ip: args.ip,
    });
  },

  /** refresh_token grant: rotate the refresh token, issue a fresh access token. */
  async refreshGrant(args: {
    refreshToken: string;
    clientId: string;
    userAgent?: string | undefined;
    ip?: string | undefined;
  }): Promise<Record<string, unknown>> {
    const row = await prisma.tenantMcpRefreshToken.findUnique({
      where: { tokenHash: sha256Hex(args.refreshToken) },
    });
    const invalid = (): never => {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid, expired, or revoked.');
    };
    if (!row || row.expiresAt <= new Date() || row.revokedAt !== null) invalid();
    if (row!.clientId !== args.clientId) {
      throw new OAuthError('invalid_grant', 'Refresh token is not valid for this client.');
    }
    // Atomic revoke — losing the race means somebody already redeemed this
    // token (reuse attempt → refuse).
    const revoked = await prisma.tenantMcpRefreshToken.updateMany({
      where: { id: row!.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) {
      throw new OAuthError('invalid_grant', 'Refresh token could not be rotated (possible reuse).');
    }
    // Re-confirm membership.
    const membership = await prisma.tenantMembership.findUnique({
      where: {
        tenantUserId_tenantId: { tenantUserId: row!.tenantUserId, tenantId: row!.tenantId },
      },
    });
    if (!membership) {
      throw new OAuthError(
        'invalid_grant',
        'Operator is no longer a member of the workspace this token was issued for.',
      );
    }
    const issued = await this.issueTokens({
      tenantUserId: row!.tenantUserId,
      tenantId: row!.tenantId,
      clientId: args.clientId,
      // Carry the grant forward verbatim — a refresh never widens or drops scope.
      scope: row!.scope,
      userAgent: args.userAgent,
      ip: args.ip,
    });
    // Record the rotation chain on the old row.
    const newHash = sha256Hex(String((issued as { refresh_token: string }).refresh_token));
    const newRow = await prisma.tenantMcpRefreshToken.findUnique({
      where: { tokenHash: newHash },
    });
    if (newRow) {
      await prisma.tenantMcpRefreshToken
        .update({ where: { id: row!.id }, data: { replacedById: newRow.id } })
        .catch(() => undefined);
    }
    return issued;
  },

  /** Shared token-response builder (auth-code + refresh paths). */
  async issueTokens(args: {
    tenantUserId: string;
    tenantId: string;
    clientId: string;
    scope: string;
    userAgent?: string | undefined;
    ip?: string | undefined;
  }): Promise<Record<string, unknown>> {
    const access = issueOperatorMcpAccessToken({
      tenantUserId: args.tenantUserId,
      tenantId: args.tenantId,
      clientId: args.clientId,
      audience: operatorMcpIssuer(),
      scope: args.scope,
    });
    const rawRefresh = randomBytes(32).toString('base64url');
    await prisma.tenantMcpRefreshToken.create({
      data: {
        tokenHash: sha256Hex(rawRefresh),
        tenantUserId: args.tenantUserId,
        tenantId: args.tenantId,
        clientId: args.clientId,
        scope: args.scope,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: args.userAgent ?? null,
        ip: args.ip ?? null,
      },
    });
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round((access.expiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: rawRefresh,
      scope: args.scope,
    };
  },

  /** RFC 7662 token introspection. Returns the active claims or `{ active:false }`. */
  introspect(token: string): Record<string, unknown> {
    const claims: OperatorMcpAccessClaims | null = verifyOperatorMcpAccessToken(
      token,
      operatorMcpIssuer(),
    );
    if (!claims) return { active: false };
    return {
      active: true,
      sub: claims.sub,
      tid: claims.tid,
      scope: claims.scope,
      aud: claims.aud,
      exp: claims.exp,
      iat: claims.iat,
      token_type: 'Bearer',
      client_id: claims.cid,
    };
  },
};
