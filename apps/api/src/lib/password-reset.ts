/**
 * Password reset token issuance + verification.
 *
 * This module only mints, looks up and consumes tokens — it does not deliver
 * them. `authService.requestPasswordReset` hands the raw token to
 * `emailService.dispatch` first; only when no transport is configured does it
 * fall back to returning the raw token to the calling *server* (and never to a
 * publishable-key caller, which runs in the browser). That fallback is the
 * original "Rekey does not send email" contract, kept so a self-host with no
 * Resend key still works and so customers who want their own from-address
 * branding and deliverability can keep owning it.
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
