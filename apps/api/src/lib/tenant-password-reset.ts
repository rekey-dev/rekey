/**
 * Tenant-operator password reset tokens.
 *
 * Mirrors `lib/password-reset.ts` for the operator side. ReliPay still
 * doesn't send email — the bootstrap flow returns the raw token so the
 * deploying organisation can hand it off to whatever mailer they like
 * (or, in dev, click through directly).
 *
 * 1-hour lifetime, single-use, hash-only DB.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { TenantPasswordResetToken } from '@prisma/client';
import { prisma } from './prisma.js';

const TOKEN_BYTES = 32;
const LIFETIME_MS = 60 * 60 * 1000;

export function hashTenantResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedTenantResetToken {
  raw: string;
  record: TenantPasswordResetToken;
}

export async function issueTenantResetToken(
  tenantUserId: string,
): Promise<IssuedTenantResetToken> {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const record = await prisma.tenantPasswordResetToken.create({
    data: {
      tenantUserId,
      tokenHash: hashTenantResetToken(raw),
      expiresAt: new Date(Date.now() + LIFETIME_MS),
    },
  });
  return { raw, record };
}

export type TenantResetLookup =
  | { kind: 'ok'; token: TenantPasswordResetToken }
  | { kind: 'unknown' }
  | { kind: 'consumed'; token: TenantPasswordResetToken }
  | { kind: 'expired'; token: TenantPasswordResetToken };

export async function lookupTenantResetToken(raw: string): Promise<TenantResetLookup> {
  const token = await prisma.tenantPasswordResetToken.findUnique({
    where: { tokenHash: hashTenantResetToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.consumedAt !== null) return { kind: 'consumed', token };
  if (token.expiresAt <= new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

export async function consumeTenantResetToken(
  token: TenantPasswordResetToken,
): Promise<boolean> {
  const result = await prisma.tenantPasswordResetToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
