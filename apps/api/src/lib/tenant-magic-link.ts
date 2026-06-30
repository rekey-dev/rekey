/**
 * Tenant-operator magic-link (passwordless sign-in) tokens.
 *
 * Mirrors `lib/tenant-password-reset.ts`. ReliPay doesn't send operator email —
 * the request flow returns the raw token so the deploying org hands it off to
 * whatever mailer they use (or, in dev, clicks through directly). Distinct from
 * the reset token because /verify mints a SESSION (it does not change a
 * password), and it's shorter-lived.
 *
 * 15-minute lifetime, single-use, hash-only DB.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { TenantMagicLinkToken } from '@prisma/client';
import { prisma } from './prisma.js';

const TOKEN_BYTES = 32;
const LIFETIME_MS = 15 * 60 * 1000;

export function hashTenantMagicLinkToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedTenantMagicLinkToken {
  raw: string;
  record: TenantMagicLinkToken;
}

export async function issueTenantMagicLinkToken(
  tenantUserId: string,
): Promise<IssuedTenantMagicLinkToken> {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const record = await prisma.tenantMagicLinkToken.create({
    data: {
      tenantUserId,
      tokenHash: hashTenantMagicLinkToken(raw),
      expiresAt: new Date(Date.now() + LIFETIME_MS),
    },
  });
  return { raw, record };
}

export type TenantMagicLinkLookup =
  | { kind: 'ok'; token: TenantMagicLinkToken }
  | { kind: 'unknown' }
  | { kind: 'consumed'; token: TenantMagicLinkToken }
  | { kind: 'expired'; token: TenantMagicLinkToken };

export async function lookupTenantMagicLinkToken(raw: string): Promise<TenantMagicLinkLookup> {
  const token = await prisma.tenantMagicLinkToken.findUnique({
    where: { tokenHash: hashTenantMagicLinkToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.consumedAt !== null) return { kind: 'consumed', token };
  if (token.expiresAt < new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

/** Single-use consume — race-safe (only the first caller flips consumedAt). */
export async function consumeTenantMagicLinkToken(token: TenantMagicLinkToken): Promise<boolean> {
  const result = await prisma.tenantMagicLinkToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
