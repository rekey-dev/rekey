/**
 * Operator MCP access-token issuance + verification.
 *
 * Issued by the operator MCP OAuth AS (modules/tenant-mcp/oauth.service.ts).
 * Distinct from:
 *   - End-user MCP access tokens (`mcp_access` in lib/jwt.ts), which are signed
 *     with a per-Application key derived from JWT_SECRET + tokenGeneration and
 *     are subject to the per-app kill-switch.
 *   - Operator session access tokens (`to_access` in lib/tenant-jwt.ts), which
 *     are workspace-bound but ALSO carry MFA state, refresh through panel
 *     cookies, and live for 15 minutes.
 *
 * Operator MCP access tokens sit between the two: workspace-bound like
 * `to_access`, audience-bound like `mcp_access`, no MFA challenge step (the
 * authorize page already collects the password + workspace pick), one-hour
 * lifetime paired with a refresh token (TenantMcpRefreshToken). Signing key
 * is JWT_SECRET directly — no per-operator kill-switch counter today;
 * revocation happens via the refresh-token chain (revoke + reuse-detect).
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface OperatorMcpAccessClaims {
  typ: 'op_mcp_access';
  /** TenantUser id. */
  sub: string;
  /** Workspace this token is bound to (chosen at /oauth/authorize consent). */
  tid: string;
  /** OAuth client this token was issued to. Carried through refresh rotations. */
  cid: string;
  /** MCP resource URL (audience binding). */
  aud: string;
  /** Granted scopes — space-separated per RFC 6749, but we issue a single scope today. */
  scope: string;
  iat: number;
  exp: number;
}

/** 1-hour access lifetime, paired with a long-lived rotating refresh token. */
const DEFAULT_LIFETIME_SECONDS = 60 * 60;

export interface IssueOperatorMcpAccessArgs {
  tenantUserId: string;
  tenantId: string;
  clientId: string;
  audience: string;
  scope: string;
  lifetimeSeconds?: number;
}

/**
 * Sign and return an operator MCP access token.
 *
 * `typ: 'op_mcp_access'` is the discriminator — refusing any other typ in
 * `verifyOperatorMcpAccessToken` stops a panel session JWT from ever
 * authenticating against the operator MCP endpoint and vice-versa.
 */
export function issueOperatorMcpAccessToken(
  args: IssueOperatorMcpAccessArgs,
): { token: string; expiresAt: Date } {
  const lifetime = args.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  const token = jwt.sign(
    {
      typ: 'op_mcp_access' as const,
      sub: args.tenantUserId,
      tid: args.tenantId,
      cid: args.clientId,
      scope: args.scope,
    },
    env.JWT_SECRET,
    { expiresIn: lifetime, algorithm: 'HS256', audience: args.audience },
  );
  return { token, expiresAt: new Date(Date.now() + lifetime * 1000) };
}

/**
 * Verify an operator MCP access token. The audience parameter MUST be the
 * MCP resource URL (`/api/v1/tenant/mcp`); a token issued for that URL won't
 * authenticate against any other resource. Returns claims on success, `null`
 * on any failure (bad signature, expired, wrong audience, wrong `typ`).
 */
export function verifyOperatorMcpAccessToken(
  token: string,
  expectedAudience: string,
): OperatorMcpAccessClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      audience: expectedAudience,
    });
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      (decoded as Record<string, unknown>).typ !== 'op_mcp_access' ||
      typeof (decoded as Record<string, unknown>).sub !== 'string' ||
      typeof (decoded as Record<string, unknown>).tid !== 'string' ||
      typeof (decoded as Record<string, unknown>).cid !== 'string'
    ) {
      return null;
    }
    return decoded as unknown as OperatorMcpAccessClaims;
  } catch {
    return null;
  }
}
