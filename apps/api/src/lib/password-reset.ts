/**
 * Password reset token issuance + verification.
 *
 * **ReliPay does not send email.** `requestPasswordReset` returns the raw
 * token to the calling server, which then emails (or SMSes, or pushes) it
 * to the user via its own provider. This keeps us out of the
 * email-deliverability business and lets each customer own their from-address
 * branding.
 *
 * Storage matches RefreshToken: SHA-256 hash, hash-only DB. Single-use:
 * `consumedAt` is set on first successful reset.
 *
 * Lifetime: 1 hour. Short enough that a leaked token expires before most
 * email-search attacks; long enough for a user to actually click through.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { PasswordResetToken } from '@prisma/client';
import { prisma } from './prisma.js';

const TOKEN_BYTES = 32;
const LIFETIME_MS = 60 * 60 * 1000; // 1 hour

export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedResetToken {
  raw: string;
  record: PasswordResetToken;
}

/**
 * Mint a new reset token for an end-user. Returns the raw value (single-use,
 * caller must email immediately) and the DB record (audit / debug).
 */
export async function issueResetToken(
  applicationId: string,
  endUserId: string,
): Promise<IssuedResetToken> {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const record = await prisma.passwordResetToken.create({
    data: {
      applicationId,
      endUserId,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() + LIFETIME_MS),
    },
  });
  return { raw, record };
}

export type ResetLookup =
  | { kind: 'ok'; token: PasswordResetToken }
  | { kind: 'unknown' }
  | { kind: 'consumed'; token: PasswordResetToken }
  | { kind: 'expired'; token: PasswordResetToken };

export async function lookupResetToken(raw: string): Promise<ResetLookup> {
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.consumedAt !== null) return { kind: 'consumed', token };
  if (token.expiresAt <= new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

/**
 * Atomically mark the token consumed. Race-safe via updateMany — concurrent
 * reset attempts won't both succeed.
 */
export async function consumeResetToken(token: PasswordResetToken): Promise<boolean> {
  const result = await prisma.passwordResetToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
