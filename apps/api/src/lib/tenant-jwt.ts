/**
 * Tenant-operator JWT — separate from the end-user JWT (lib/jwt.ts) because
 * its claims are different.
 *
 * Token shapes (discriminated by `typ`):
 *
 *   "to_access"        — operator session access token.
 *                        { typ, sub, tid, rol, iat, exp }
 *   "to_mfa_challenge" — short-lived intermediate token issued at sign-in
 *                        when the operator has MFA enrolled. Holds an
 *                        unauthenticated identity; can only be exchanged
 *                        via /tenant/auth/mfa-verify for a real session.
 *                        { typ, sub, iat, exp }
 *
 * `typ` is load-bearing: it stops an end-user JWT from ever satisfying the
 * tenant-session middleware even if claim names happened to align, AND it
 * stops a challenge token from being mistaken for a session token.
 *
 * `tid` + `rol` are also load-bearing — the session middleware uses them to
 * scope every request to the active workspace and to gate role-restricted
 * routes. To switch workspaces, the operator calls /tenant/switch-workspace,
 * which mints a new pair of tokens with a different tid.
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { TenantRole } from '@prisma/client';

export type TenantTokenType = 'to_access' | 'to_mfa_challenge';

export interface TenantSessionClaims {
  typ: 'to_access';
  sub: string;
  tid: string;
  rol: TenantRole;
  iat: number;
  exp: number;
}

export interface TenantMfaChallengeClaims {
  typ: 'to_mfa_challenge';
  sub: string;
  iat: number;
  exp: number;
}

const DEFAULT_LIFETIME_SECONDS = 15 * 60;
// Short-enough that a leaked challenge token is useless before email phishes
// can be acted on; long enough for a real user to fish their authenticator
// app out of their pocket.
const DEFAULT_MFA_CHALLENGE_LIFETIME_SECONDS = 5 * 60;

export function issueTenantAccessToken(
  tenantUserId: string,
  tenantId: string,
  role: TenantRole,
  options: { lifetimeSeconds?: number } = {},
): { token: string; expiresAt: Date } {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  const token = jwt.sign(
    { typ: 'to_access' as const, sub: tenantUserId, tid: tenantId, rol: role },
    env.JWT_SECRET,
    { expiresIn: lifetime, algorithm: 'HS256' },
  );
  return { token, expiresAt: new Date(Date.now() + lifetime * 1000) };
}

export function issueTenantMfaChallengeToken(
  tenantUserId: string,
  options: { lifetimeSeconds?: number } = {},
): { token: string; expiresAt: Date } {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_MFA_CHALLENGE_LIFETIME_SECONDS;
  const token = jwt.sign(
    { typ: 'to_mfa_challenge' as const, sub: tenantUserId },
    env.JWT_SECRET,
    { expiresIn: lifetime, algorithm: 'HS256' },
  );
  return { token, expiresAt: new Date(Date.now() + lifetime * 1000) };
}

export function verifyTenantAccessToken(token: string): TenantSessionClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      (decoded as Record<string, unknown>).typ !== 'to_access' ||
      typeof (decoded as Record<string, unknown>).sub !== 'string' ||
      typeof (decoded as Record<string, unknown>).tid !== 'string' ||
      typeof (decoded as Record<string, unknown>).rol !== 'string'
    ) {
      return null;
    }
    return decoded as unknown as TenantSessionClaims;
  } catch {
    return null;
  }
}

export function verifyTenantMfaChallengeToken(token: string): TenantMfaChallengeClaims | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      (decoded as Record<string, unknown>).typ !== 'to_mfa_challenge' ||
      typeof (decoded as Record<string, unknown>).sub !== 'string'
    ) {
      return null;
    }
    return decoded as unknown as TenantMfaChallengeClaims;
  } catch {
    return null;
  }
}
