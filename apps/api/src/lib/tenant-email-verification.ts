/**
 * The token behind an operator's "confirm your email" link.
 *
 * Same storage as the operator sign-in and reset links: 32 random bytes, only
 * the SHA-256 kept, single use by a conditional update. It lasts a day,
 * because unlike a sign-in link it gives nobody a session: opening it sets
 * `emailVerified` on the account it was mailed for and changes nothing else.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { TenantEmailVerificationToken } from '@prisma/client';
import { prisma } from './prisma.js';

const TOKEN_BYTES = 32;
const LIFETIME_MS = 24 * 60 * 60 * 1000;

export function hashTenantEmailVerificationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedTenantEmailVerificationToken {
  raw: string;
  record: TenantEmailVerificationToken;
}

/**
 * Mint a confirmation token for the address the account has now. The
 * account's unused earlier tokens are deleted in the same transaction, so a
 * newer email replaces the older ones: one working link per account, and the
 * table does not grow with every resend.
 *
 * @example
 *   const issued = await issueTenantEmailVerificationToken(user.id, user.email);
 */
export async function issueTenantEmailVerificationToken(
  tenantUserId: string,
  email: string,
): Promise<IssuedTenantEmailVerificationToken> {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const [, record] = await prisma.$transaction([
    prisma.tenantEmailVerificationToken.deleteMany({ where: { tenantUserId, consumedAt: null } }),
    prisma.tenantEmailVerificationToken.create({
      data: {
        tenantUserId,
        email,
        tokenHash: hashTenantEmailVerificationToken(raw),
        expiresAt: new Date(Date.now() + LIFETIME_MS),
      },
    }),
  ]);
  return { raw, record };
}

export type TenantEmailVerificationLookup =
  | { kind: 'ok'; token: TenantEmailVerificationToken }
  | { kind: 'unknown' }
  | { kind: 'consumed'; token: TenantEmailVerificationToken }
  | { kind: 'expired'; token: TenantEmailVerificationToken };

/**
 * Read a presented token without spending it.
 *
 * @example
 *   const outcome = await lookupTenantEmailVerificationToken(raw);
 */
export async function lookupTenantEmailVerificationToken(raw: string): Promise<TenantEmailVerificationLookup> {
  const token = await prisma.tenantEmailVerificationToken.findUnique({
    where: { tokenHash: hashTenantEmailVerificationToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.consumedAt !== null) return { kind: 'consumed', token };
  if (token.expiresAt <= new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}
