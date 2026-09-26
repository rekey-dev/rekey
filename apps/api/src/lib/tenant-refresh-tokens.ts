/**
 * Tenant-operator refresh tokens.
 *
 * Same machinery as `lib/refresh-tokens.ts` but writes to `tenant_refresh_tokens`
 * and is keyed by `tenantUserId` instead of `endUserId`. Could be unified
 * with a polymorphic helper, but the cost is one extra type parameter
 * everywhere; the duplication is tiny and stays auditable.
 *
 * Configurable lifetime (30 days by default), single-use, hash-only DB. Race-safe rotation via
 * updateMany. Mirror the contract of `lib/refresh-tokens.ts` exactly so
 * the parallel structure is the documentation.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, TenantRefreshToken } from '@prisma/client';
import { invalidateOperatorAuth } from './operator-auth-cache.js';
import { prisma } from './prisma.js';
import { env } from '../config/env.js';

const REFRESH_TOKEN_BYTES = 32;
// OPERATOR_REFRESH_TOKEN_TTL_DAYS (default 30), sliding like the end-user one.
const REFRESH_TOKEN_LIFETIME_MS = env.OPERATOR_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export function hashTenantRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export interface IssuedTenantRefreshToken {
  raw: string;
  record: TenantRefreshToken;
}

export interface IssueTenantRefreshTokenOptions {
  userAgent?: string | null;
  ip?: string | null;
  /**
   * The workspace the session is minted into. Refresh re-emits it as `tid`
   * while the operator is still a member (see tenantAuthService.refresh).
   */
  activeTenantId?: string | null;
}

/**
 * `client` lets a caller that is inside a transaction write the token with
 * its other changes (invitation accept), so the session commits or rolls back
 * with them and no second pool connection is taken mid-transaction.
 */
export async function issueTenantRefreshToken(
  tenantUserId: string,
  options: IssueTenantRefreshTokenOptions = {},
  client: Prisma.TransactionClient = prisma,
): Promise<IssuedTenantRefreshToken> {
  const raw = generateRawToken();
  const ua = options.userAgent ? options.userAgent.slice(0, 512) : null;
  const ip = options.ip ? options.ip.slice(0, 64) : null;
  const record = await client.tenantRefreshToken.create({
    data: {
      tenantUserId,
      tokenHash: hashTenantRefreshToken(raw),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS),
      userAgent: ua,
      ip,
      activeTenantId: options.activeTenantId ?? null,
    },
  });
  return { raw, record };
}

export type TenantRefreshOutcome =
  | { kind: 'ok'; token: TenantRefreshToken }
  | { kind: 'unknown' }
  | { kind: 'revoked'; token: TenantRefreshToken }
  | { kind: 'expired'; token: TenantRefreshToken };

export async function lookupTenantRefreshToken(raw: string): Promise<TenantRefreshOutcome> {
  const token = await prisma.tenantRefreshToken.findUnique({
    where: { tokenHash: hashTenantRefreshToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.revokedAt !== null) return { kind: 'revoked', token };
  if (token.expiresAt <= new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

/**
 * `activeTenantId` is the workspace the replacement row is scoped to. It
 * defaults to the presented row's; the refresh handler passes the workspace it
 * re-checked against live memberships, so a fallback is written by the
 * rotation itself and nothing can fail after the presented token is spent.
 */
export async function rotateTenantRefreshToken(
  presented: TenantRefreshToken,
  activeTenantId: string | null = presented.activeTenantId,
): Promise<IssuedTenantRefreshToken> {
  const raw = generateRawToken();
  const tokenHash = hashTenantRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS);

  return prisma.$transaction(async (tx) => {
    const revoked = await tx.tenantRefreshToken.updateMany({
      where: { id: presented.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new Error('TENANT_REFRESH_RACE');

    const replacement = await tx.tenantRefreshToken.create({
      data: {
        tenantUserId: presented.tenantUserId,
        tokenHash,
        expiresAt,
        // Carry forward UA/IP so the operator's session list stays stable.
        userAgent: presented.userAgent,
        ip: presented.ip,
        // Same session, same `sid` on the access token minted from it.
        sessionId: presented.sessionId,
        // And the same workspace, unless the refresh handler's membership
        // re-check moved it.
        activeTenantId,
      },
    });
    await tx.tenantRefreshToken.update({
      where: { id: presented.id },
      data: { replacedById: replacement.id },
    });
    return { raw, record: replacement };
  });
}

export async function revokeTenantRefreshToken(raw: string): Promise<void> {
  // Returning the owner is what lets sign-out drop the cached session: the
  // presented refresh token is the only thing that names it.
  const revoked = await prisma.tenantRefreshToken.updateManyAndReturn({
    where: { tokenHash: hashTenantRefreshToken(raw), revokedAt: null },
    data: { revokedAt: new Date() },
    select: { tenantUserId: true },
  });
  for (const row of revoked) invalidateOperatorAuth(row.tenantUserId);
}

export async function revokeAllTenantRefreshTokensForUser(
  tenantUserId: string,
): Promise<number> {
  // See TenantUser.sessionsInvalidBefore: the operator's live access tokens,
  // panel and operator MCP OAuth alike, are refused from this instant, whatever
  // their lifetime.
  //
  // The operator's MCP OAuth refresh tokens are revoked here too. They are a
  // separate table with their own chain, and until they were included a
  // password reset or sign-out everywhere left a stolen MCP refresh token
  // minting hour-long `op_mcp_access` tokens, write scope included. Only this
  // revoke-everything path reaches them: a single-session revoke leaves every
  // MCP connection alone, as it does the operator's other panel sessions.
  // One transaction, so the stamp never lands without the revocations.
  const now = new Date();
  const [, panel] = await prisma.$transaction([
    prisma.tenantUser.updateMany({ where: { id: tenantUserId }, data: { sessionsInvalidBefore: now } }),
    prisma.tenantRefreshToken.updateMany({
      where: { tenantUserId, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.tenantMcpRefreshToken.updateMany({
      where: { tenantUserId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
  // After the commit, never before: a request that re-reads between an
  // earlier invalidation and the commit would cache the pre-revoke rows.
  invalidateOperatorAuth(tenantUserId);
  // The panel session count, as before: it is what sign-out-everywhere reports.
  return panel.count;
}

export interface TenantSessionSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export async function listActiveTenantSessions(
  tenantUserId: string,
  opts: { take?: number; skip?: number } = {},
): Promise<{ items: TenantSessionSummary[]; total: number }> {
  // One `now` for rows and count, see listActiveSessions (lib/refresh-tokens.ts).
  const now = new Date();
  const where = { tenantUserId, revokedAt: null, expiresAt: { gt: now } };
  const [items, total] = await Promise.all([
    prisma.tenantRefreshToken.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        userAgent: true,
        ip: true,
      },
      ...(opts.take !== undefined && { take: opts.take }),
      ...(opts.skip !== undefined && { skip: opts.skip }),
    }),
    prisma.tenantRefreshToken.count({ where }),
  ]);
  return { items, total };
}

export async function revokeSessionForTenantUser(
  tenantUserId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await prisma.tenantRefreshToken.updateMany({
    where: { id: sessionId, tenantUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  // No per-operator stamp: it would end every other session's access token,
  // and the panel does not renew safely on that 401 (see
  // revokeSessionForEndUser). The revoked session's access token is refused
  // by its `sid`, since this row is now the revoked head of its family.
  //
  // The cache is dropped for the whole operator, not just this `sid`: the
  // row id the caller passed is not the family id the cache is keyed on, and
  // re-reading the operator's other sessions once costs one query each.
  if (result.count === 1) invalidateOperatorAuth(tenantUserId);
  return result.count === 1;
}
