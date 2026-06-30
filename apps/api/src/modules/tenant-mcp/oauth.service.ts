/**
 * Operator MCP OAuth 2.1 authorization server.
 *
 * Mirrors the per-Application MCP OAuth shape (modules/mcp/oauth.service.ts)
 * but binds tokens to a (tenantUserId, tenantId) pair the operator picks at
 * the consent page. Operators sign in with their normal panel email +
 * password (`argon2.verify`) — no second credential to issue.
 *
 * Standards: RFC 8414 / RFC 9728 (metadata), RFC 7591 (dynamic registration),
 * RFC 6749 / RFC 7636 (authorization code + PKCE), RFC 7662 (introspection).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { env } from '../../config/env.js';
import { verifyPassword } from '../../lib/passwords.js';
import {
  issueOperatorMcpAccessToken,
  verifyOperatorMcpAccessToken,
  type OperatorMcpAccessClaims,
} from '../../lib/operator-mcp-jwt.js';
import type { TenantRole } from '@prisma/client';

/** The only scope Phase 2 grants — read access across the operator's workspace. */
export const OPERATOR_MCP_SCOPE = 'mcp:operator:read';

const AUTH_CODE_TTL_MS = 60 * 1000; // 60s, single-use
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
// Consent flow step-1 → step-2 carry-through token. Long enough to pick a
// workspace, short enough to be useless if it leaks from a saved page.
const CONSENT_TOKEN_TTL_SECONDS = 5 * 60;

/**
 * OAuth error (RFC 6749 §5.2). Carried distinctly from RelipayError because
 * the token endpoint must emit the `{ error, error_description }` shape OAuth
 * clients parse — not the ReliPay envelope.
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
    scopes_supported: [OPERATOR_MCP_SCOPE],
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
    scopes_supported: [OPERATOR_MCP_SCOPE],
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
      throw new RelipayError({
        statusCode: 400,
        code: 'INVALID_REDIRECT_URI',
        message: 'redirect_uris must contain between 1 and 20 entries.',
        fix: 'Register at least one redirect URI (and no more than 20).',
      });
    }
    for (const uri of redirectUris) {
      if (!isAcceptableRedirectUri(uri)) {
        throw new RelipayError({
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
   * Sign-in by email + password. Validates the operator exists, hasn't been
   * disabled by the brute-force lockout layer (we deliberately don't gate on
   * email verification — operators with unverified mailboxes can still mint
   * MCP tokens, mirroring the panel sign-in behaviour). Returns the operator
   * id + their workspace memberships for the consent page to choose from.
   */
  async signInForConsent(
    email: string,
    password: string,
  ): Promise<{
    tenantUserId: string;
    name: string | null;
    memberships: Array<{ tenantId: string; tenantName: string; role: TenantRole }>;
  } | null> {
    const user = await prisma.tenantUser.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        memberships: { include: { tenant: { select: { name: true } } } },
      },
    });
    if (!user) return null;
    if (!user.passwordHash) return null;
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return null;
    return {
      tenantUserId: user.id,
      name: user.name,
      memberships: user.memberships.map((m) => ({
        tenantId: m.tenantId,
        tenantName: m.tenant.name,
        role: m.role,
      })),
    };
  },

  /**
   * Mint the short-lived token that carries "this operator passed the
   * password check" from the login step to the workspace-pick/consent step
   * of /oauth/authorize. Previously the form round-tripped the raw password
   * in a hidden field — echoing a credential back into HTML (page saves,
   * extensions, proxies with response logging). Bound to the OAuth client
   * so a token minted for one authorize flow can't drive another client's.
   * Same posture as the end-user MFA challenge token (lib/jwt.ts): signed,
   * 5-minute TTL, not a session.
   */
  issueConsentToken(tenantUserId: string, clientId: string): string {
    return jwt.sign(
      { typ: 'op_mcp_consent' as const, sub: tenantUserId, cid: clientId },
      env.JWT_SECRET,
      { expiresIn: CONSENT_TOKEN_TTL_SECONDS, algorithm: 'HS256' },
    );
  },

  /** Verify a consent carry-through token. Returns the tenantUserId or null. */
  verifyConsentToken(token: string, clientId: string): string | null {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        (decoded as Record<string, unknown>).typ !== 'op_mcp_consent' ||
        (decoded as Record<string, unknown>).cid !== clientId ||
        typeof (decoded as Record<string, unknown>).sub !== 'string'
      ) {
        return null;
      }
      return (decoded as Record<string, unknown>).sub as string;
    } catch {
      return null;
    }
  },

  /** Workspace memberships for the consent page (step 2 re-reads them by id). */
  async membershipsForConsent(
    tenantUserId: string,
  ): Promise<Array<{ tenantId: string; tenantName: string; role: TenantRole }>> {
    const memberships = await prisma.tenantMembership.findMany({
      where: { tenantUserId },
      include: { tenant: { select: { name: true } } },
    });
    return memberships.map((m) => ({
      tenantId: m.tenantId,
      tenantName: m.tenant.name,
      role: m.role,
    }));
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
      row.expiresAt < new Date()
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
    if (!row || row.expiresAt < new Date() || row.revokedAt !== null) invalid();
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
      scope: OPERATOR_MCP_SCOPE,
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
