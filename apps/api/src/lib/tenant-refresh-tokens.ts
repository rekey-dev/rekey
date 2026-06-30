/**
 * Tenant-operator refresh tokens.
 *
 * Same machinery as `lib/refresh-tokens.ts` but writes to `tenant_refresh_tokens`
 * and is keyed by `tenantUserId` instead of `endUserId`. Could be unified
 * with a polymorphic helper, but the cost is one extra type parameter
 * everywhere; the duplication is tiny and stays auditable.
 *
 * 30-day lifetime, single-use, hash-only DB. Race-safe rotation via
 * updateMany. Mirror the contract of `lib/refresh-tokens.ts` exactly so
 * the parallel structure is the documentation.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { TenantRefreshToken } from '@prisma/client';
import { prisma } from './prisma.js';

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

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
}

export async function issueTenantRefreshToken(
  tenantUserId: string,
  options: IssueTenantRefreshTokenOptions = {},
): Promise<IssuedTenantRefreshToken> {
  const raw = generateRawToken();
  const ua = options.userAgent ? options.userAgent.slice(0, 512) : null;
  const ip = options.ip ? options.ip.slice(0, 64) : null;
  const record = await prisma.tenantRefreshToken.create({
    data: {
      tenantUserId,
      tokenHash: hashTenantRefreshToken(raw),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS),
      userAgent: ua,
      ip,
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
  if (token.expiresAt < new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

export async function rotateTenantRefreshToken(
  presented: TenantRefreshToken,
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
  await prisma.tenantRefreshToken.updateMany({
    where: { tokenHash: hashTenantRefreshToken(raw), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllTenantRefreshTokensForUser(
  tenantUserId: string,
): Promise<number> {
  const result = await prisma.tenantRefreshToken.updateMany({
    where: { tenantUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
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
): Promise<TenantSessionSummary[]> {
  const rows = await prisma.tenantRefreshToken.findMany({
    where: {
      tenantUserId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      userAgent: true,
      ip: true,
    },
  });
  return rows;
}

export async function revokeSessionForTenantUser(
  tenantUserId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await prisma.tenantRefreshToken.updateMany({
    where: { id: sessionId, tenantUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count === 1;
}
